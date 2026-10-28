import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { IsString, IsUUID, Matches } from "class-validator";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { ExportsService } from "./exports.service";

class CreateExport {
  @IsUUID("4") requestId!: string;
  @IsUUID("4") childId!: string;
  @IsString() @Matches(/^\d{4}(?:-(?:0[1-9]|1[0-2]|Q[1-4]))?$/) period!: string;
}
@Controller("families/:familyId/exports")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}
  @Get() @Header("Cache-Control", "no-store")
  list(@Req() r: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) f: string) { return this.exports.list(r.auth.user.id, f); }
  @Post() @Header("Cache-Control", "no-store")
  create(@Req() r: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) f: string, @Body() b: CreateExport) { return this.exports.create(r.auth.user.id, f, b.childId, b.period, b.requestId); }
  @Delete(":id")
  cancel(@Req() r: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) f: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) { return this.exports.cancel(r.auth.user.id, f, id); }
  @Post(":id/confirm") @Header("Cache-Control", "no-store")
  confirm(@Req() r: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) f: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) { return this.exports.confirm(r.auth.user.id, f, id); }
  @Post(":id/parts/:part/download") @Header("Cache-Control", "no-store")
  download(@Req() r: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) f: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Param("part", ParseIntPipe) part: number) { return this.exports.download(r.auth.user.id, f, id, part); }
}
