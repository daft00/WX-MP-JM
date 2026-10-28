import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { Equals, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";
import { Transform } from "class-transformer";
import { Public, AuthenticatedRequest } from "../auth/auth.guard";
import { AdminPageDto } from "../admin/admin.dto";
import { GovernanceService } from "./governance.service";
import { DeletionService } from "./deletion.service";

class Consent {
  @Matches(/^[a-f0-9]{64}$/) version!: string;
  @Equals(true) accepted!: boolean;
  @Equals(true) guardian!: boolean;
}
class DataRequest {
  @IsUUID("4") requestId!: string;
  @IsIn(["DATA_DELETE", "FAMILY_DISSOLVE"]) kind!: string;
  @IsUUID("4") familyId!: string;
  @IsOptional() @IsUUID("4") entryId?: string;
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(1, 500) reason!: string;
}
class Review {
  @IsIn(["APPROVED", "REJECTED"]) decision!: "APPROVED" | "REJECTED";
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(1, 400) reason!: string;
}
class Execute { @Equals(true) confirmed!: boolean; }
@Controller("governance")
export class GovernanceController {
  constructor(private readonly service: GovernanceService, private readonly deletion: DeletionService) {}
  @Public() @Get("documents") @Header("Cache-Control", "no-store")
  documents() { return this.service.documents(); }
  @Get("consent") @Header("Cache-Control", "no-store")
  status(@Req() r: AuthenticatedRequest) { return this.service.status(r.auth.user.id); }
  @Post("consent") @Header("Cache-Control", "no-store")
  accept(@Req() r: AuthenticatedRequest, @Body() b: Consent) { return this.service.accept(r.auth.user.id, b.version); }
  @Get("requests") @Header("Cache-Control", "no-store")
  list(@Req() r: AuthenticatedRequest, @Query() q: AdminPageDto) { return this.service.list(r.auth.user.id, q); }
  @Post("requests")
  submit(@Req() r: AuthenticatedRequest, @Body() b: DataRequest) { return this.service.submit(r.auth.user.id, b); }
  @Delete("requests/:id")
  cancel(@Req() r: AuthenticatedRequest, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) { return this.service.cancel(r.auth.user.id, id); }
  @Post("requests/:id/execute")
  execute(@Req() r: AuthenticatedRequest, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() _b: Execute) { return this.deletion.execute(r.auth.user.id, id); }
  @Get("admin/requests") @Header("Cache-Control", "no-store")
  admin(@Req() r: AuthenticatedRequest, @Query() q: AdminPageDto) { return this.service.list(r.auth.user.id, q, true); }
  @Post("admin/requests/:id/review")
  review(@Req() r: AuthenticatedRequest, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() b: Review) { return this.service.review(r.auth.user.id, id, b.decision, b.reason); }
}
