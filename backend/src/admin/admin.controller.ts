import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Query, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { AdminPageDto, AdminReasonDto, AdminRoleDto, AuditQueryDto } from "./admin.dto";
import { AdminService } from "./admin.service";

@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("dashboard") @Header("Cache-Control", "no-store")
  dashboard(@Req() req: AuthenticatedRequest) { return this.admin.dashboard(req.auth.user.id); }

  @Get("families") @Header("Cache-Control", "no-store")
  families(@Req() req: AuthenticatedRequest, @Query() query: AdminPageDto) { return this.admin.listFamilies(req.auth.user.id, query); }

  @Get("users") @Header("Cache-Control", "no-store")
  users(@Req() req: AuthenticatedRequest, @Query() query: AdminPageDto) { return this.admin.listUsers(req.auth.user.id, query); }

  @Get("audit-logs") @Header("Cache-Control", "no-store")
  audits(@Req() req: AuthenticatedRequest, @Query() query: AuditQueryDto) { return this.admin.audits(req.auth.user.id, query); }

  @Get("families/:familyId/members") @Header("Cache-Control", "no-store")
  members(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string, @Query() query: AdminPageDto) {
    return this.admin.members(req.auth.user.id, familyId, query);
  }

  @Patch("families/:familyId/members/:memberId") @Header("Cache-Control", "no-store")
  role(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("memberId", new ParseUUIDPipe({ version: "4" })) memberId: string, @Body() body: AdminRoleDto) {
    return this.admin.changeRole(req.auth.user.id, familyId, memberId, body);
  }

  @Delete("families/:familyId/members/:memberId") @HttpCode(204) @Header("Cache-Control", "no-store")
  remove(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("memberId", new ParseUUIDPipe({ version: "4" })) memberId: string, @Body() body: AdminReasonDto) {
    return this.admin.remove(req.auth.user.id, familyId, memberId, body.reason);
  }
}
