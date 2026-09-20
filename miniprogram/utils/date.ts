export function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDate(value: string): string {
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
  let months = (target.getFullYear() - birth.getFullYear()) * 12;
  months += target.getMonth() - birth.getMonth();
  if (target.getDate() < birth.getDate()) {
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
