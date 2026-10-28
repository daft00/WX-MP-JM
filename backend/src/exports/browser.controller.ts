import { GovernanceService } from "../governance/governance.service";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Body, Controller, ForbiddenException, Get, Header, Param, ParseIntPipe, ParseUUIDPipe, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IsString, IsUUID, Matches } from "class-validator";
import { Request, Response } from "express";
import QRCode from "qrcode";
import { Public, AuthenticatedRequest } from "../auth/auth.guard";
import { DatabaseService } from "../database/database.service";
import { ExportsService } from "./exports.service";
import { browserPage } from "./browser-page";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const cookie = "__Secure-growth-export";
class ConfirmPair {
  @IsUUID("4") id!: string;
  @IsUUID("4") familyId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) secret!: string;
}
@Controller("export-browser")
export class BrowserController {
  constructor(private readonly db: DatabaseService, private readonly exports: ExportsService, private readonly config: ConfigService, private readonly governance: GovernanceService) {}
  private origin(r: Request) {
    const origin = this.config.get<string>("EXPORT_PUBLIC_ORIGIN");
    if (!origin) throw new ServiceUnavailableException("Computer export is not configured");
    if (!r.secure || r.headers.origin !== origin) throw new ForbiddenException();
  }
  @Public() @Get() @Header("Content-Type", "text/html; charset=utf-8") @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer") @Header("X-Frame-Options", "DENY")
  page(@Res() res: Response) {
    const nonce = randomBytes(16).toString("hex");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    res.type("html").send(browserPage(nonce));
  }
  @Public() @Post("pair") @UseGuards(ThrottlerGuard) @Header("Cache-Control", "no-store")
  async pair(@Req() r: Request, @Res({ passthrough: true }) res: Response) {
    this.origin(r);
    const id = randomUUID(), browser = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
    await this.db.transaction(async m => {
      // Bound anonymous storage even before timer installation.
      await m.query("DELETE FROM export_pairings WHERE COALESCE(session_expires_at, expires_at) < UTC_TIMESTAMP(3)");
      const [{ n }] = await m.query("SELECT COUNT(*) AS n FROM export_pairings");
      if (Number(n) >= 500) throw new ServiceUnavailableException();
      await m.query("INSERT INTO export_pairings (id, browser_hash, confirm_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))", [id, hash(browser), hash(secret)]);
    });
    res.cookie(cookie, `${id}.${browser}`, { secure: true, httpOnly: true, sameSite: "strict", path: "/api/v1/export-browser", maxAge: 20 * 60 * 1000 });
    return { qr: await QRCode.toDataURL(`growth-export:${id}:${secret}`), code: id.slice(-6), expiresIn: 300 };
  }
  @Post("confirm") @Header("Cache-Control", "no-store")
  confirm(@Req() r: AuthenticatedRequest, @Body() b: ConfirmPair) {
    return this.db.transaction(async m => {
      await this.exports.admin(m, b.familyId, r.auth.user.id);
      const [p] = await m.query("SELECT * FROM export_pairings WHERE id = ? FOR UPDATE", [b.id]);
      if (!p || p.user_id || p.expires_at.getTime() <= Date.now() || p.confirm_hash !== hash(b.secret)) throw new ForbiddenException();
      await m.query("UPDATE export_pairings SET user_id = ?, family_id = ?, session_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE) WHERE id = ?", [r.auth.user.id, b.familyId, b.id]);
      return { confirmed: true };
    });
  }
  private async session(r: Request) {
    this.origin(r);
    const raw = r.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${cookie}=`))?.slice(cookie.length + 1) || "";
    const [id, secret] = raw.split(".");
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(secret || "")) throw new UnauthorizedException();
    return this.db.transaction(async m => {
      const [p] = await m.query("SELECT * FROM export_pairings WHERE id = ?", [id]);
      if (!p || p.browser_hash !== hash(secret) || !p.user_id || !p.session_expires_at || p.session_expires_at.getTime() <= Date.now()) throw new UnauthorizedException();
      await this.exports.admin(m, p.family_id, p.user_id);
      await this.governance.requireConsent(p.user_id); return p;
    });
  }
  @Public() @Post("jobs") @Header("Cache-Control", "no-store")
  async jobs(@Req() r: Request) { const s = await this.session(r); return this.exports.list(s.user_id, s.family_id); }
  @Public() @Post("jobs/:id/:part") @Header("Cache-Control", "no-store")
  async download(@Req() r: Request, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Param("part", ParseIntPipe) part: number) {
    const s = await this.session(r); return this.exports.download(s.user_id, s.family_id, id, part);
  }
  @Public() @Post("logout")
  async logout(@Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.session(r);
    await this.db.transaction(m => m.query("DELETE FROM export_pairings WHERE id = ?", [s.id]));
    res.clearCookie(cookie, { secure: true, httpOnly: true, sameSite: "strict", path: "/api/v1/export-browser" }); return { ok: true };
  }
}
