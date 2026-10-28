import {
  Asset,
  Child,
  ChildDraft,
  CursorPage,
  Entry,
  EntryDraft,
  ExportJob,
  Family,
  FamilySelection,
  FamilyMember,
  Id,
  Invite,
  Session,
  IdentitySession,
  MetricType,
  MetricValue,
  User,
  Role,
  SystemAdminDashboard,
  SystemFamilyOverview,
  SystemUserOverview,
} from "../types/models";

export interface EntryQuery {
  year?: string;
  childId?: Id;
  cursor?: string;
  pageSize?: number;
}

export interface LocalMediaFile {
  tempFilePath: string;
  size: number;
  fileType?: "image" | "video";
  thumbTempFilePath?: string;
}

export interface AuthService {
  hasSession(): boolean;
  login(): Promise<IdentitySession>;
  getIdentity(): Promise<IdentitySession>;
  logout(): Promise<void>;
  updateNickname(nickname: string): Promise<IdentitySession>;
  getSession(): Promise<Session>;
  listPrototypeUsers(): Promise<User[]>;
  listPrototypeSessions(): Promise<Session[]>;
  switchPrototypeUser(userId: Id): Promise<Session>;
  resetPrototypeData(): Promise<void>;
}

export interface FamilyService {
  creationStatus(): Promise<{ canCreate: boolean }>;
  listAccessibleFamilies(): Promise<Family[]>;
  getCurrentFamily(): Promise<Family>;
  listMembers(): Promise<FamilyMember[]>;
  getSelection(): Promise<FamilySelection>;
  selectFamily(familyId: Id): Promise<Family>;
  selectChild(childId: Id): Promise<Child>;
  clearSelection(): Promise<void>;
  createFamily(name: string): Promise<Family>;
  createInvite(): Promise<Invite>;
  joinFamily(code: string): Promise<Family>;
  updateMemberRole(memberId: Id, role: Extract<Role, "ADMIN" | "MEMBER">): Promise<FamilyMember>;
  removeMember(memberId: Id): Promise<void>;
}

export interface ChildService {
  list(): Promise<Child[]>;
  get(id: Id): Promise<Child>;
  save(draft: ChildDraft): Promise<Child>;
}

export interface EntryService {
  metrics(childId: Id, type: MetricType, cursor?: string): Promise<CursorPage<MetricValue>>;
  listYears(childId: Id): Promise<string[]>;
  list(query?: EntryQuery): Promise<CursorPage<Entry>>;
  get(id: Id): Promise<Entry>;
  save(draft: EntryDraft): Promise<Entry>;
  deletePermanent(id: Id): Promise<void>;
  canEdit(entry: Entry): Promise<boolean>;
  canDelete(): Promise<boolean>;
}

export interface UploadOptions {
  progress?: (message: string) => void;
  saved?: (asset: Asset) => void;
  cancelled?: () => boolean;
}
export interface UploadService {
  discardPending(): Promise<void>;
  quota(): Promise<{ enabled: boolean; quotaBytes: number; usedBytes: number; reservedBytes: number }>;
  resumePending(childId: Id, options?: UploadOptions): Promise<Asset[]>;
  saveLocalMedia(childId: Id, files: LocalMediaFile[], options?: UploadOptions): Promise<Asset[]>;
  getAssets(ids: Id[]): Promise<Asset[]>;
}

export interface ExportService {
  authorizeComputer(id: string, secret: string): Promise<void>;
  list(): Promise<ExportJob[]>;
  create(childId: Id, period: string, options?: { progress?: (message: string) => void; cancelled?: () => boolean }): Promise<ExportJob>;
  getArchivePath(id: Id, part?: number): Promise<string>;
  deleteArchive(id: Id): Promise<void>;
  markDownloaded(id: Id): Promise<ExportJob>;
  confirmManualBackup(id: Id): Promise<ExportJob>;
}

export interface AdminPage<T> {
  items: T[]; page: number; pageSize: number; hasMore: boolean;
}

export type FailedTaskKind = "MEDIA" | "EXPORT" | "DELETION";
export interface FailedTask {
  id: string; kind: FailedTaskKind; familyId: string; status: string; error: string; updatedAt: string;
  attempts: number | null; nextAttemptAt: string | null; canRetry: boolean; cleaned: boolean | null;
}
export interface AuditFilter { familyId?: string; actorId?: string; action?: string }
export interface AuditRecord {
  id: string; actorId: string; familyId: string | null; action: string;
  targetType: string; targetId: string | null; reason: string; createdAt: string;
}
export interface StorageQuota { enabled: boolean; quotaBytes: number; usedBytes: number; reservedBytes: number }
export interface SystemAdminService {
  quota(familyId: Id): Promise<StorageQuota>;
  setQuota(familyId: Id, quotaBytes: number, reason: string): Promise<StorageQuota>;
  listMembers(familyId: Id, page: number): Promise<AdminPage<FamilyMember>>;
  audits(page: number, filter: AuditFilter): Promise<AdminPage<AuditRecord>>;
  failedTasks(kind: FailedTaskKind, page: number): Promise<AdminPage<FailedTask>>;
  retryMedia(id: string, reason: string): Promise<{ id: string; scheduled: boolean }>;
  listFamilies(page: number): Promise<AdminPage<Omit<SystemFamilyOverview, "members">>>;
  listUsers(page: number): Promise<AdminPage<SystemUserOverview>>;
  approveFamilyCreation(userId: Id, reason: string): Promise<{ userId: Id; canCreate: boolean }>;
  getDashboard(): Promise<SystemAdminDashboard>;
  updateMemberRole(familyId: Id, memberId: Id, role: Extract<Role, "ADMIN" | "MEMBER">, reason: string): Promise<FamilyMember>;
  removeMember(familyId: Id, memberId: Id, reason: string): Promise<void>;
}

export interface ServiceContainer {
  governance: GovernanceApi;
  auth: AuthService;
  family: FamilyService;
  children: ChildService;
  entries: EntryService;
  uploads: UploadService;
  exports: ExportService;
  systemAdmin: SystemAdminService;
}

export interface PolicyDocument {
  enabled: boolean; ready: boolean; version: string; paragraphs: string[]; contact: string; accepted?: boolean;
}
export interface DataApplication {
  id: string; kind: string; reason: string; status: string; review_reason?: string; created_at: string;
  target_family_id?: string; entry_id?: string; last_error?: string; completed_at?: string;
}
export interface GovernanceApi {
  documents(): Promise<PolicyDocument>;
  status(): Promise<PolicyDocument>;
  accept(version: string): Promise<void>;
  list(page: number, admin?: boolean): Promise<{ items: DataApplication[]; hasMore: boolean }>;
  submit(body: { requestId: string; kind: string; reason: string; familyId: string; entryId?: string }): Promise<DataApplication>;
  execute(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  review(id: string, decision: string, reason: string): Promise<void>;
  leave(): Promise<void>;
  transfer(memberId: string): Promise<void>;
}
