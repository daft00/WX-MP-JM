import { Transform } from "class-transformer";
import { IsString, Length, Matches, ValidateBy } from "class-validator";

export function isBirthday(value: unknown, now = new Date()): boolean {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return value <= `${part("year")}-${part("month")}-${part("day")}`;
}

// POST 和 PUT 使用完整表单；不接受客户端指定归属家庭或创建者。
export class SaveChildDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(1, 12)
  name!: string;

  @ValidateBy({ name: "birthday", validator: { validate: (value: unknown) => isBirthday(value), defaultMessage: () => "birthday must be a real YYYY-MM-DD date, not later than today in Asia/Shanghai" } })
  birthday!: string;

  @Transform(({ value }) => typeof value === "string" ? value.trim() || "宝宝" : value)
  @IsString()
  @Length(1, 8)
  genderLabel: string = "宝宝";

  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  avatarColor: string = "#F0A58A";
}
