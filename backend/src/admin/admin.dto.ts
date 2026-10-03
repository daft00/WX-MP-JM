import { Transform } from "class-transformer";
import { IsIn, IsInt, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from "class-validator";

export class AdminPageDto {
  @Transform(({ value }) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(10000) page = 1;
  @Transform(({ value }) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(100) pageSize = 20;
}
export class AuditQueryDto extends AdminPageDto {
  @ValidateIf((_object, value) => value !== undefined) @IsUUID("4") familyId?: string;
  @ValidateIf((_object, value) => value !== undefined) @IsUUID("4") actorId?: string;
  @ValidateIf((_object, value) => value !== undefined) @IsString() @Matches(/^[A-Z][A-Z0-9_]{0,79}$/) action?: string;
}
export class AdminReasonDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(1, 400) reason!: string;
}
export class AdminRoleDto extends AdminReasonDto {
  @IsIn(["ADMIN", "MEMBER"]) role!: "ADMIN" | "MEMBER";
}
