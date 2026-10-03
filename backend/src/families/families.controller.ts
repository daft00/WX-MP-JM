import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Transform } from "class-transformer";
import { IsIn, IsString, Length, Matches } from "class-validator";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { FamiliesService } from "./families.service";

class CreateFamilyDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 20)
  name!: string;
}
class JoinFamilyDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim().toUpperCase() : value)
  @IsString()
  @Matches(/^[A-F0-9]{16}$/)
  code!: string;
}
class MemberRoleDto {
  @IsIn(["ADMIN", "MEMBER"])
  role!: "ADMIN" | "MEMBER";
}

@Controller("families")
export class FamiliesController {
  constructor(private readonly families: FamiliesService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() request: AuthenticatedRequest) { return this.families.list(request.auth.user.id); }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Header("Cache-Control", "no-store")
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateFamilyDto) { return this.families.create(request.auth.user.id, body.name); }

  @Post("join")
  @UseGuards(ThrottlerGuard)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  join(@Req() request: AuthenticatedRequest, @Body() body: JoinFamilyDto) { return this.families.join(request.auth.user.id, body.code); }

  @Get(":familyId")
  @Header("Cache-Control", "no-store")
  get(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.families.get(request.auth.user.id, id);
  }

  @Get(":familyId/members")
  @Header("Cache-Control", "no-store")
  members(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.families.members(request.auth.user.id, id);
  }

  @Post(":familyId/invites")
  @UseGuards(ThrottlerGuard)
  @Header("Cache-Control", "no-store")
  invite(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.families.createInvite(request.auth.user.id, id);
  }

  @Patch(":familyId/members/:memberId")
  @Header("Cache-Control", "no-store")
  role(@Req() request: AuthenticatedRequest,
    @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("memberId", new ParseUUIDPipe({ version: "4" })) memberId: string, @Body() body: MemberRoleDto) {
    return this.families.changeRole(request.auth.user.id, familyId, memberId, body.role);
  }

  @Delete(":familyId/members/:memberId")
  @HttpCode(204)
  remove(@Req() request: AuthenticatedRequest,
    @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("memberId", new ParseUUIDPipe({ version: "4" })) memberId: string) {
    return this.families.remove(request.auth.user.id, familyId, memberId);
  }
}
