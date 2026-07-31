export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CompanyChoice {
  id: string;
  name: string;
}

export type LoginResult =
  | { status: 'authenticated'; accessToken: string; company: CompanyChoice }
  | { status: 'choose_company'; preAuthToken: string; companies: CompanyChoice[] };

export interface CurrentUser {
  userId: string;
  username: string;
  fullName: string;
  company: { id: string; name: string; jurisdiction: string };
  membershipId: string;
  role: { id: string; name: string };
  permissions: string[];
  /** Null if this login has no linked Operator record — DriverOS has nothing to show. */
  operator: { id: string; fullName: string } | null;
}

export type JobStatus = 'UNASSIGNED' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';

export type StopOutcome = 'PENDING' | 'DELIVERED' | 'FAILED';
export type StopFailureReason = 'NOBODY_HOME' | 'ACCESS_DENIED' | 'BUSINESS_CLOSED' | 'ADDRESS_ISSUE' | 'REFUSED' | 'OTHER';

export interface JobStop {
  id: string;
  sequence: number;
  label: string;
  address: string | null;
  contactName: string | null;
  outcome: StopOutcome;
  completedAt: string | null;
  recipientName: string | null;
  note: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  failureReason: StopFailureReason | null;
  podAttachment?: { id: string; filename: string; contentType: string } | null;
}

export interface Job {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  assetId: string | null;
  operatorId: string | null;
  status: JobStatus;
  scheduledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The API includes the full asset row on a job; DriverOS only needs these
   * fields. `registration` is here so the fuel screen can pre-fill the plate of
   * the vehicle the driver is actually in.
   */
  asset?: { id: string; name: string; registration?: string | null } | null;
  pickupDepot?: { id: string; name: string; address: string | null } | null;
  stops?: JobStop[];
}

export type ComplianceDocumentType = 'REGISTRATION' | 'INSURANCE' | 'ROADWORTHY' | 'LICENCE' | 'MEDICAL_CERTIFICATE';
export type ComplianceExpiryStatus = 'valid' | 'expiring_soon' | 'expired';

export interface ComplianceDocument {
  id: string;
  documentType: ComplianceDocumentType;
  documentNumber: string | null;
  expiresAt: string;
  expiryStatus: ComplianceExpiryStatus;
  /** The scanned document, as metadata only — the bytes are fetched on demand
   *  (needs a connection). Present when the office attached a scan/photo. */
  fileAttachment: { id: string; filename: string; contentType: string; byteSize: number } | null;
}

// `text` items take a written answer instead of pass/fail.
export type ChecklistItemType = 'pass_fail' | 'pass_fail_na' | 'text';

export interface ChecklistItem {
  id: string;
  label: string;
  type: ChecklistItemType;
  requireNoteOnFail: boolean;
  createsFaultOnFail: boolean;
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  version: number;
  items: ChecklistItem[];
  appliesToAssetClass: { key: string } | null;
}

export type ChecklistAnswerStatus = 'pass' | 'fail' | 'na';

export interface ChecklistAnswer {
  itemId: string;
  // Absent on a `text` item (it carries its written answer in `note`).
  status?: ChecklistAnswerStatus;
  note?: string;
}

export type FormFieldType = 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'asset_ref' | 'operator_ref';

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options: string[] | null;
  showIfFieldId: string | null;
  showIfValue: string | null;
}

export type FormTargetContext = 'DRIVER' | 'OFFICE' | 'BOTH';

export interface FormTemplate {
  id: string;
  name: string;
  description: string | null;
  version: number;
  fields: FormField[];
  /**
   * Optional guidance document the office attached. Opening it needs a
   * connection — the form itself still works entirely offline.
   */
  referenceDocument: { id: string; title: string } | null;
}

export interface FormAnswer {
  fieldId: string;
  value: unknown;
}

export type FatigueStatus = 'ok' | 'approaching_limit' | 'breach' | 'not_assessed';

export interface FatigueRuleFlag {
  rule: string;
  label: string;
  message: string;
}

export interface OperatorFatigueStatus {
  operatorId: string;
  status: FatigueStatus;
  breaches: FatigueRuleFlag[];
  approaching: FatigueRuleFlag[];
  workMinutesLast24h: number;
  workMinutesLast7d: number;
}

export type MessageSenderType = 'OPERATOR' | 'OFFICE';

export interface Message {
  id: string;
  operatorId: string;
  senderType: MessageSenderType;
  senderUserId: string | null;
  body: string;
  createdAt: string;
  senderUser?: { id: string; fullName: string } | null;
}

export interface MessageThread {
  operatorId: string;
  items: Message[];
}
