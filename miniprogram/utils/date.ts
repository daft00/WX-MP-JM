export function today(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

export function formatDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${year}年${Number(month)}月${Number(day)}日`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(value)} ${hour}:${minute}`;
}

export function calculateAge(birthday: string, at: string = today()): string {
  const birth = new Date(birthday);
  const target = new Date(at);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(target.getTime())) {
    return "年龄未知";
  }
  let months = (target.getUTCFullYear() - birth.getUTCFullYear()) * 12;
  months += target.getUTCMonth() - birth.getUTCMonth();
  if (target.getUTCDate() < birth.getUTCDate()) {
    months -= 1;
  }
  months = Math.max(0, months);
  if (months < 12) {
    return `${months}个月`;
  }
  const years = Math.floor(months / 12);
  const remaining = months % 12;
  return remaining > 0 ? `${years}岁${remaining}个月` : `${years}岁`;
}

export function addHours(value: Date, hours: number): string {
  return new Date(value.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function yearMonth(value: string): string {
  return value.slice(0, 7);
}
