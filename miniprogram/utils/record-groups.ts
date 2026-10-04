export interface RecordMonth<T> {
  key: string;
  label: string;
  entries: T[];
}

export interface RecordYear<T> {
  year: string;
  months: RecordMonth<T>[];
}

// 日期为 YYYY-MM-DD，按记录发生日期归档，不使用上传时间。
export function groupRecords<T extends { id: string; occurredAt: string }>(entries: T[]): RecordYear<T>[] {
  const years: RecordYear<T>[] = [];
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  unique.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  for (const entry of unique) {
    const year = entry.occurredAt.slice(0, 4), key = entry.occurredAt.slice(0, 7);
    let yearGroup = years[years.length - 1];
    if (!yearGroup || yearGroup.year !== year) {
      yearGroup = { year, months: [] };
      years.push(yearGroup);
    }
    let month = yearGroup.months[yearGroup.months.length - 1];
    if (!month || month.key !== key) {
      month = { key, label: `${Number(key.slice(5))}月`, entries: [] };
      yearGroup.months.push(month);
    }
    month.entries.push(entry);
  }
  return years;
}
