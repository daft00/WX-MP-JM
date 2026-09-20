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
} from "../types/models";

export interface EntryQuery {
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
  getSession(): Promise<Session>;
  listPrototypeSessions(): Promise<Session[]>;
  switchPrototypeUser(userId: Id): Promise<Session>;
  resetPrototypeData(): Promise<void>;
}

export interface FamilyService {
  listAccessibleFamilies(): Promise<Family[]>;
  getCurrentFamily(): Promise<Family>;
  listMembers(): Promise<FamilyMember[]>;
  getSelection(): Promise<FamilySelection>;
  selectFamily(familyId: Id): Promise<Family>;
  selectChild(childId: Id): Promise<Child>;
  clearSelection(): Promise<void>;
  createInvite(): Promise<Invite>;
}

export interface ChildService {
  list(): Promise<Child[]>;
  get(id: Id): Promise<Child>;
  save(draft: ChildDraft): Promise<Child>;
}

export interface EntryService {
  list(query?: EntryQuery): Promise<CursorPage<Entry>>;
  get(id: Id): Promise<Entry>;
  save(draft: EntryDraft): Promise<Entry>;
  deletePermanent(id: Id): Promise<void>;
  canEdit(entry: Entry): Promise<boolean>;
  canDelete(): Promise<boolean>;
}

export interface UploadService {
  saveLocalMedia(childId: Id, files: LocalMediaFile[]): Promise<Asset[]>;
  getAssets(ids: Id[]): Promise<Asset[]>;
}

export interface ExportService {
  list(): Promise<ExportJob[]>;
  create(childId: Id, selectedYearMonth: string): Promise<ExportJob>;
  markDownloaded(id: Id): Promise<ExportJob>;
  confirmManualBackup(id: Id): Promise<ExportJob>;
}

export interface ServiceContainer {
  auth: AuthService;
  family: FamilyService;
  children: ChildService;
  entries: EntryService;
  uploads: UploadService;
  exports: ExportService;
}
