export type Id = string;
export type Role = "OWNER" | "ADMIN" | "MEMBER";
export type EntryKind = "DIARY" | "MILESTONE";
export type AssetKind = "IMAGE" | "VIDEO";
export type MetricType = "HEIGHT" | "WEIGHT" | "HEAD";
export type ExportStatus = "PENDING" | "PROCESSING" | "READY" | "DOWNLOADED" | "CONFIRMED";

export interface User {
  id: Id;
  nickname: string;
  avatarText: string;
}

export interface Family {
  id: Id;
  name: string;
  ownerId: Id;
  createdAt: string;
}

export interface FamilyMember {
  id: Id;
  familyId: Id;
  userId: Id;
  role: Role;
  joinedAt: string;
  user: User;
}

export interface Child {
  id: Id;
  familyId: Id;
  creatorId: Id;
  name: string;
  birthday: string;
  genderLabel: string;
  avatarColor: string;
  createdAt: string;
}

export interface Asset {
  id: Id;
  familyId: Id;
  childId: Id;
  creatorId: Id;
  kind: AssetKind;
  name: string;
  localPath?: string;
  posterPath?: string;
  placeholderTone: string;
  volatile?: boolean;
  createdAt: string;
}

export interface MetricValue {
  id: Id;
  familyId: Id;
  childId: Id;
  creatorId: Id;
  entryId: Id;
  type: MetricType;
  value: number;
  unit: "cm" | "kg";
  measuredAt: string;
}

export interface Entry {
  id: Id;
  familyId: Id;
  childId: Id;
  creatorId: Id;
  kind: EntryKind;
  title: string;
  body: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  assetIds: Id[];
  customEvent?: string;
  metric?: MetricValue;
}

export interface Invite {
  id: Id;
  familyId: Id;
  creatorId: Id;
  code: string;
  expiresAt: string;
  usedAt?: string;
}

export interface ExportJob {
  id: Id;
  familyId: Id;
  childId: Id;
  creatorId: Id;
  yearMonth: string;
  status: ExportStatus;
  partCount: number;
  createdAt: string;
  expiresAt?: string;
  confirmedAt?: string;
}

export interface Session {
  user: User;
  family: Family;
  membership: FamilyMember;
}

export interface EntryDraft {
  id?: Id;
  childId: Id;
  kind: EntryKind;
  title: string;
  body: string;
  occurredAt: string;
  assetIds: Id[];
  customEvent?: string;
  metricType?: MetricType;
  metricValue?: number;
}

export interface ChildDraft {
  id?: Id;
  name: string;
  birthday: string;
  genderLabel: string;
  avatarColor: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface PrototypeState {
  version: number;
  activeUserId: Id;
  activeFamilyId: Id;
  activeChildId: Id;
  users: User[];
  families: Family[];
  members: FamilyMember[];
  children: Child[];
  entries: Entry[];
  assets: Asset[];
  invites: Invite[];
  exports: ExportJob[];
}

export interface FamilySelection {
  familyId: Id;
  childId: Id;
}
