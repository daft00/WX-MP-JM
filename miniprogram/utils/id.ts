export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function createInviteCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
