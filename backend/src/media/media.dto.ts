import { Transform } from "class-transformer";
import { IsIn, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class UploadDto {
  @IsUUID("4") requestId!: string;
  @IsUUID("4") childId!: string;
  @IsIn(["IMAGE", "VIDEO"]) kind!: "IMAGE" | "VIDEO";
  @IsString() @MinLength(1) @MaxLength(255) name!: string;
  @IsInt() @Min(1) @Max(50 * 1024 * 1024) sizeBytes!: number;
}

export class StorageQuotaDto {
  @IsInt() @Min(1) @Max(1024 * 1024 * 1024 * 1024) quotaBytes!: number;
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(470) reason!: string;
}
