import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsNumber, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateBy, ValidateIf } from "class-validator";
import { isBirthday } from "../children/children.dto";

export class SaveEntryDto {
  @IsUUID("4") childId!: string;
  @IsIn(["DIARY", "MILESTONE"]) kind!: "DIARY" | "MILESTONE";
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @Length(1, 60) title!: string;
  @IsString() @MaxLength(2000) body: string = "";
  @ValidateBy({ name: "entryDate", validator: { validate: (value: unknown) => isBirthday(value), defaultMessage: () => "occurredAt must be a real YYYY-MM-DD date not later than today in Asia/Shanghai" } })
  occurredAt!: string;
  @IsArray() @ArrayMaxSize(9) @ArrayUnique() @IsUUID("4", { each: true }) assetIds: string[] = [];
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString() @MaxLength(100) customEvent?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["HEIGHT", "WEIGHT", "HEAD"]) metricType?: "HEIGHT" | "WEIGHT" | "HEAD";
  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 3, allowInfinity: false, allowNaN: false }) @Min(0.001) @Max(9999999.999)
  metricValue?: number;
}

class PageQueryDto {
  @Transform(({ value }) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(200) pageSize: number = 20;
  @ValidateIf((_object, value) => value !== undefined) @IsString() @Length(1, 600) cursor?: string;
}

export class EntryQueryDto extends PageQueryDto {
  @ValidateIf((_object, value) => value !== undefined) @IsUUID("4") childId?: string;
}

export class MetricQueryDto extends PageQueryDto {
  @IsUUID("4") childId!: string;
  @IsIn(["HEIGHT", "WEIGHT", "HEAD"]) type!: "HEIGHT" | "WEIGHT" | "HEAD";
}
