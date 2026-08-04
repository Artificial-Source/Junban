declare module 'junban:plugin/types@0.1.0' {
  export type Id = string;
  export type Date = string;
  export type CivilTime = string;
  export type TimeZoneName = string;
  export type Timestamp = string;
  export type OperationId = string;
  /**
   * # Variants
   *
   * ## `"p1"`
   *
   * ## `"p2"`
   *
   * ## `"p3"`
   *
   * ## `"p4"`
   */
  export type Priority = 'p1' | 'p2' | 'p3' | 'p4';
  /**
   * # Variants
   *
   * ## `"pending"`
   *
   * ## `"completed"`
   *
   * ## `"cancelled"`
   */
  export type TaskStatus = 'pending' | 'completed' | 'cancelled';
  /**
   * # Variants
   *
   * ## `"list"`
   *
   * ## `"board"`
   *
   * ## `"calendar"`
   */
  export type ProjectView = 'list' | 'board' | 'calendar';
  /**
   * # Variants
   *
   * ## `"debug"`
   *
   * ## `"info"`
   *
   * ## `"warn"`
   *
   * ## `"error"`
   */
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
  /**
   * # Variants
   *
   * ## `"invalid-input"`
   *
   * ## `"not-found"`
   *
   * ## `"conflict"`
   *
   * ## `"cursor-stale"`
   *
   * ## `"permission-denied"`
   *
   * ## `"unavailable"`
   *
   * ## `"rate-limited"`
   *
   * ## `"cancelled"`
   *
   * ## `"internal"`
   */
  export type ErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'cursor-stale' | 'permission-denied' | 'unavailable' | 'rate-limited' | 'cancelled' | 'internal';
  export interface HostError {
    code: ErrorCode,
    field?: string,
    message: string,
  }
  export interface PluginError {
    code: ErrorCode,
    field?: string,
    message: string,
  }
  export type ScalarValue = ScalarValueStringValue | ScalarValueIntegerValue | ScalarValueBooleanValue | ScalarValueDateValue | ScalarValueTimestampValue | ScalarValueTaskId | ScalarValueProjectId | ScalarValueTagId | ScalarValuePluginId | ScalarValueOptionId;
  export interface ScalarValueStringValue {
    tag: 'string-value',
    val: string,
  }
  export interface ScalarValueIntegerValue {
    tag: 'integer-value',
    val: bigint,
  }
  export interface ScalarValueBooleanValue {
    tag: 'boolean-value',
    val: boolean,
  }
  export interface ScalarValueDateValue {
    tag: 'date-value',
    val: Date,
  }
  export interface ScalarValueTimestampValue {
    tag: 'timestamp-value',
    val: Timestamp,
  }
  export interface ScalarValueTaskId {
    tag: 'task-id',
    val: Id,
  }
  export interface ScalarValueProjectId {
    tag: 'project-id',
    val: Id,
  }
  export interface ScalarValueTagId {
    tag: 'tag-id',
    val: Id,
  }
  export interface ScalarValuePluginId {
    tag: 'plugin-id',
    val: Id,
  }
  export interface ScalarValueOptionId {
    tag: 'option-id',
    val: Id,
  }
  export type DataValue = DataValueScalar | DataValueStringList | DataValueIntegerList | DataValueBooleanList | DataValueDateList | DataValueTimestampList | DataValueTaskIdList | DataValueProjectIdList | DataValueTagIdList | DataValuePluginIdList | DataValueOptionIdList;
  export interface DataValueScalar {
    tag: 'scalar',
    val: ScalarValue,
  }
  export interface DataValueStringList {
    tag: 'string-list',
    val: Array<string>,
  }
  export interface DataValueIntegerList {
    tag: 'integer-list',
    val: BigInt64Array,
  }
  export interface DataValueBooleanList {
    tag: 'boolean-list',
    val: Array<boolean>,
  }
  export interface DataValueDateList {
    tag: 'date-list',
    val: Array<Date>,
  }
  export interface DataValueTimestampList {
    tag: 'timestamp-list',
    val: Array<Timestamp>,
  }
  export interface DataValueTaskIdList {
    tag: 'task-id-list',
    val: Array<Id>,
  }
  export interface DataValueProjectIdList {
    tag: 'project-id-list',
    val: Array<Id>,
  }
  export interface DataValueTagIdList {
    tag: 'tag-id-list',
    val: Array<Id>,
  }
  export interface DataValuePluginIdList {
    tag: 'plugin-id-list',
    val: Array<Id>,
  }
  export interface DataValueOptionIdList {
    tag: 'option-id-list',
    val: Array<Id>,
  }
  export interface NamedValue {
    name: Id,
    value: DataValue,
  }
  export interface ScalarNamedValue {
    name: Id,
    value: ScalarValue,
  }
  export interface InvocationContext {
    pluginId: Id,
    packageGeneration: bigint,
    activationEpoch: bigint,
    hostSessionId: Id,
    invocationId: OperationId,
    entryId?: Id,
  }
  export interface LocalDueTime {
    time: CivilTime,
    timeZone: TimeZoneName,
  }
  export interface TaskQuery {
    taskId?: Id,
    projectId?: Id,
    sectionId?: Id,
    parentId?: Id,
    tagIds: Array<Id>,
    statuses: Array<TaskStatus>,
    priorities: Array<Priority>,
    dueFrom?: Date,
    dueBefore?: Date,
    search?: string,
    cursor?: string,
    limit: number,
  }
  export interface TaskView {
    id: Id,
    title: string,
    description: string,
    status: TaskStatus,
    priority?: Priority,
    dueDate?: Date,
    dueTime?: LocalDueTime,
    deadline?: Timestamp,
    someday: boolean,
    estimatedMinutes?: number,
    actualMinutes?: number,
    dread?: number,
    projectId?: Id,
    sectionId?: Id,
    parentId?: Id,
    tagIds: Array<Id>,
    sortOrder: bigint,
    recurrenceRule?: string,
    remindAt?: Timestamp,
    recurrenceAnchorDay?: number,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    revision: bigint,
  }
  export interface TaskPage {
    items: Array<TaskView>,
    nextCursor?: string,
    revision: bigint,
  }
  export interface CatalogQuery {
    cursor?: string,
    limit: number,
  }
  export interface ProjectViewRecord {
    id: Id,
    name: string,
    color: string,
    icon?: string,
    parentId?: Id,
    favorite: boolean,
    archived: boolean,
    view: ProjectView,
    sortOrder: bigint,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    revision: bigint,
  }
  export interface ProjectPage {
    items: Array<ProjectViewRecord>,
    nextCursor?: string,
    revision: bigint,
  }
  export interface TagView {
    id: Id,
    name: string,
    color: string,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    revision: bigint,
  }
  export interface TagPage {
    items: Array<TagView>,
    nextCursor?: string,
    revision: bigint,
  }
  export type StringChange = StringChangeUnchanged | StringChangeSet;
  export interface StringChangeUnchanged {
    tag: 'unchanged',
  }
  export interface StringChangeSet {
    tag: 'set',
    val: string,
  }
  export type BoolChange = BoolChangeUnchanged | BoolChangeSet;
  export interface BoolChangeUnchanged {
    tag: 'unchanged',
  }
  export interface BoolChangeSet {
    tag: 'set',
    val: boolean,
  }
  export type S64Change = S64ChangeUnchanged | S64ChangeSet;
  export interface S64ChangeUnchanged {
    tag: 'unchanged',
  }
  export interface S64ChangeSet {
    tag: 'set',
    val: bigint,
  }
  export type ProjectViewChange = ProjectViewChangeUnchanged | ProjectViewChangeSet;
  export interface ProjectViewChangeUnchanged {
    tag: 'unchanged',
  }
  export interface ProjectViewChangeSet {
    tag: 'set',
    val: ProjectView,
  }
  export type OptionalStringChange = OptionalStringChangeUnchanged | OptionalStringChangeClear | OptionalStringChangeSet;
  export interface OptionalStringChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalStringChangeClear {
    tag: 'clear',
  }
  export interface OptionalStringChangeSet {
    tag: 'set',
    val: string,
  }
  export type OptionalIdChange = OptionalIdChangeUnchanged | OptionalIdChangeClear | OptionalIdChangeSet;
  export interface OptionalIdChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalIdChangeClear {
    tag: 'clear',
  }
  export interface OptionalIdChangeSet {
    tag: 'set',
    val: Id,
  }
  export type OptionalDateChange = OptionalDateChangeUnchanged | OptionalDateChangeClear | OptionalDateChangeSet;
  export interface OptionalDateChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalDateChangeClear {
    tag: 'clear',
  }
  export interface OptionalDateChangeSet {
    tag: 'set',
    val: Date,
  }
  export type OptionalTimestampChange = OptionalTimestampChangeUnchanged | OptionalTimestampChangeClear | OptionalTimestampChangeSet;
  export interface OptionalTimestampChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalTimestampChangeClear {
    tag: 'clear',
  }
  export interface OptionalTimestampChangeSet {
    tag: 'set',
    val: Timestamp,
  }
  export type OptionalLocalDueTimeChange = OptionalLocalDueTimeChangeUnchanged | OptionalLocalDueTimeChangeClear | OptionalLocalDueTimeChangeSet;
  export interface OptionalLocalDueTimeChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalLocalDueTimeChangeClear {
    tag: 'clear',
  }
  export interface OptionalLocalDueTimeChangeSet {
    tag: 'set',
    val: LocalDueTime,
  }
  export type OptionalU32Change = OptionalU32ChangeUnchanged | OptionalU32ChangeClear | OptionalU32ChangeSet;
  export interface OptionalU32ChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalU32ChangeClear {
    tag: 'clear',
  }
  export interface OptionalU32ChangeSet {
    tag: 'set',
    val: number,
  }
  export type OptionalU8Change = OptionalU8ChangeUnchanged | OptionalU8ChangeClear | OptionalU8ChangeSet;
  export interface OptionalU8ChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalU8ChangeClear {
    tag: 'clear',
  }
  export interface OptionalU8ChangeSet {
    tag: 'set',
    val: number,
  }
  export type OptionalPriorityChange = OptionalPriorityChangeUnchanged | OptionalPriorityChangeClear | OptionalPriorityChangeSet;
  export interface OptionalPriorityChangeUnchanged {
    tag: 'unchanged',
  }
  export interface OptionalPriorityChangeClear {
    tag: 'clear',
  }
  export interface OptionalPriorityChangeSet {
    tag: 'set',
    val: Priority,
  }
  export type IdListChange = IdListChangeUnchanged | IdListChangeReplace;
  export interface IdListChangeUnchanged {
    tag: 'unchanged',
  }
  export interface IdListChangeReplace {
    tag: 'replace',
    val: Array<Id>,
  }
  export interface TaskDraft {
    title: string,
    description: string,
    priority?: Priority,
    dueDate?: Date,
    dueTime?: LocalDueTime,
    deadline?: Timestamp,
    someday: boolean,
    estimatedMinutes?: number,
    actualMinutes?: number,
    dread?: number,
    projectId?: Id,
    sectionId?: Id,
    parentId?: Id,
    tagIds: Array<Id>,
    sortOrder: bigint,
    recurrenceRule?: string,
    remindAt?: Timestamp,
    recurrenceAnchorDay?: number,
  }
  export interface TaskPatch {
    title: StringChange,
    description: StringChange,
    priority: OptionalPriorityChange,
    dueDate: OptionalDateChange,
    dueTime: OptionalLocalDueTimeChange,
    deadline: OptionalTimestampChange,
    someday: BoolChange,
    estimatedMinutes: OptionalU32Change,
    actualMinutes: OptionalU32Change,
    dread: OptionalU8Change,
    projectId: OptionalIdChange,
    sectionId: OptionalIdChange,
    parentId: OptionalIdChange,
    tagIds: IdListChange,
    sortOrder: S64Change,
    recurrenceRule: OptionalStringChange,
    remindAt: OptionalTimestampChange,
    recurrenceAnchorDay: OptionalU8Change,
  }
  export interface PatchTask {
    taskId: Id,
    patch: TaskPatch,
  }
  export interface BulkMove {
    projectId: OptionalIdChange,
    sectionId: OptionalIdChange,
    parentId: OptionalIdChange,
  }
  export interface BulkTag {
    add: Array<Id>,
    remove: Array<Id>,
  }
  export interface BulkSchedule {
    dueDate: OptionalDateChange,
    dueTime: OptionalLocalDueTimeChange,
    deadline: OptionalTimestampChange,
    someday: BoolChange,
  }
  export type BulkPriority = BulkPriorityClear | BulkPrioritySet;
  export interface BulkPriorityClear {
    tag: 'clear',
  }
  export interface BulkPrioritySet {
    tag: 'set',
    val: Priority,
  }
  export type BulkAction = BulkActionComplete | BulkActionUncomplete | BulkActionCancel | BulkActionReopen | BulkActionDelete | BulkActionMove | BulkActionTag | BulkActionSchedule | BulkActionPriority;
  export interface BulkActionComplete {
    tag: 'complete',
  }
  export interface BulkActionUncomplete {
    tag: 'uncomplete',
  }
  export interface BulkActionCancel {
    tag: 'cancel',
  }
  export interface BulkActionReopen {
    tag: 'reopen',
  }
  export interface BulkActionDelete {
    tag: 'delete',
  }
  export interface BulkActionMove {
    tag: 'move',
    val: BulkMove,
  }
  export interface BulkActionTag {
    tag: 'tag',
    val: BulkTag,
  }
  export interface BulkActionSchedule {
    tag: 'schedule',
    val: BulkSchedule,
  }
  export interface BulkActionPriority {
    tag: 'priority',
    val: BulkPriority,
  }
  export interface BulkTasks {
    taskIds: Array<Id>,
    action: BulkAction,
  }
  export interface ProjectDraft {
    name: string,
    color: string,
    icon?: string,
    parentId?: Id,
    favorite: boolean,
    archived: boolean,
    view: ProjectView,
    sortOrder: bigint,
  }
  export interface ProjectPatch {
    name: StringChange,
    color: StringChange,
    icon: OptionalStringChange,
    parentId: OptionalIdChange,
    favorite: BoolChange,
    archived: BoolChange,
    view: ProjectViewChange,
    sortOrder: S64Change,
  }
  export interface PatchProject {
    projectId: Id,
    patch: ProjectPatch,
  }
  export interface TagDraft {
    name: string,
    color: string,
  }
  export interface TagPatch {
    name: StringChange,
    color: StringChange,
  }
  export interface PatchTag {
    tagId: Id,
    patch: TagPatch,
  }
  export type DomainMutation = DomainMutationCreateTask | DomainMutationPatchTask | DomainMutationCompleteTask | DomainMutationUncompleteTask | DomainMutationCancelTask | DomainMutationReopenTask | DomainMutationDeleteTask | DomainMutationBulkTasks | DomainMutationCreateProject | DomainMutationPatchProject | DomainMutationDeleteProject | DomainMutationCreateTag | DomainMutationPatchTag | DomainMutationDeleteTag;
  export interface DomainMutationCreateTask {
    tag: 'create-task',
    val: TaskDraft,
  }
  export interface DomainMutationPatchTask {
    tag: 'patch-task',
    val: PatchTask,
  }
  export interface DomainMutationCompleteTask {
    tag: 'complete-task',
    val: Id,
  }
  export interface DomainMutationUncompleteTask {
    tag: 'uncomplete-task',
    val: Id,
  }
  export interface DomainMutationCancelTask {
    tag: 'cancel-task',
    val: Id,
  }
  export interface DomainMutationReopenTask {
    tag: 'reopen-task',
    val: Id,
  }
  export interface DomainMutationDeleteTask {
    tag: 'delete-task',
    val: Id,
  }
  export interface DomainMutationBulkTasks {
    tag: 'bulk-tasks',
    val: BulkTasks,
  }
  export interface DomainMutationCreateProject {
    tag: 'create-project',
    val: ProjectDraft,
  }
  export interface DomainMutationPatchProject {
    tag: 'patch-project',
    val: PatchProject,
  }
  export interface DomainMutationDeleteProject {
    tag: 'delete-project',
    val: Id,
  }
  export interface DomainMutationCreateTag {
    tag: 'create-tag',
    val: TagDraft,
  }
  export interface DomainMutationPatchTag {
    tag: 'patch-tag',
    val: PatchTag,
  }
  export interface DomainMutationDeleteTag {
    tag: 'delete-tag',
    val: Id,
  }
  export interface KvSet {
    key: string,
    value: Uint8Array,
  }
  export type KvOperation = KvOperationSet | KvOperationDelete;
  export interface KvOperationSet {
    tag: 'set',
    val: KvSet,
  }
  export interface KvOperationDelete {
    tag: 'delete',
    val: string,
  }
  export interface KvPatch {
    operations: Array<KvOperation>,
  }
  export type PluginEffect = PluginEffectDomainMutation | PluginEffectKvPatch;
  export interface PluginEffectDomainMutation {
    tag: 'domain-mutation',
    val: DomainMutation,
  }
  export interface PluginEffectKvPatch {
    tag: 'kv-patch',
    val: KvPatch,
  }
  export interface PluginOutcome {
    effect?: PluginEffect,
  }
  export interface CommandCall {
    commandId: Id,
    values: Array<NamedValue>,
  }
  /**
   * # Variants
   *
   * ## `"task-created"`
   *
   * ## `"task-updated"`
   *
   * ## `"task-completed"`
   *
   * ## `"task-uncompleted"`
   *
   * ## `"task-cancelled"`
   *
   * ## `"task-reopened"`
   *
   * ## `"task-deleted"`
   *
   * ## `"project-created"`
   *
   * ## `"project-updated"`
   *
   * ## `"project-deleted"`
   *
   * ## `"tag-created"`
   *
   * ## `"tag-updated"`
   *
   * ## `"tag-deleted"`
   *
   * ## `"section-created"`
   *
   * ## `"section-updated"`
   *
   * ## `"section-deleted"`
   */
  export type EventKind = 'task-created' | 'task-updated' | 'task-completed' | 'task-uncompleted' | 'task-cancelled' | 'task-reopened' | 'task-deleted' | 'project-created' | 'project-updated' | 'project-deleted' | 'tag-created' | 'tag-updated' | 'tag-deleted' | 'section-created' | 'section-updated' | 'section-deleted';
  export type EventSubject = EventSubjectTask | EventSubjectProject | EventSubjectTag | EventSubjectDeletedTask | EventSubjectDeletedProject | EventSubjectDeletedTag | EventSubjectDeletedSection;
  export interface EventSubjectTask {
    tag: 'task',
    val: TaskView,
  }
  export interface EventSubjectProject {
    tag: 'project',
    val: ProjectViewRecord,
  }
  export interface EventSubjectTag {
    tag: 'tag',
    val: TagView,
  }
  export interface EventSubjectDeletedTask {
    tag: 'deleted-task',
    val: Id,
  }
  export interface EventSubjectDeletedProject {
    tag: 'deleted-project',
    val: Id,
  }
  export interface EventSubjectDeletedTag {
    tag: 'deleted-tag',
    val: Id,
  }
  export interface EventSubjectDeletedSection {
    tag: 'deleted-section',
    val: Id,
  }
  export interface EventEnvelope {
    eventEpoch: Id,
    revision: bigint,
    kind: EventKind,
    subject: EventSubject,
  }
  /**
   * # Variants
   *
   * ## `"neutral"`
   *
   * ## `"accent"`
   *
   * ## `"positive"`
   *
   * ## `"warning"`
   *
   * ## `"danger"`
   */
  export type UiTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';
  /**
   * # Variants
   *
   * ## `"small"`
   *
   * ## `"medium"`
   *
   * ## `"large"`
   */
  export type UiSize = 'small' | 'medium' | 'large';
  /**
   * # Variants
   *
   * ## `"start"`
   *
   * ## `"center"`
   *
   * ## `"end"`
   *
   * ## `"stretch"`
   */
  export type UiAlign = 'start' | 'center' | 'end' | 'stretch';
  export interface LayoutProps {
    gap: number,
    align: UiAlign,
  }
  export interface TextProps {
    text: string,
    tone: UiTone,
    size: UiSize,
  }
  export interface MetricProps {
    label: string,
    value: string,
    tone: UiTone,
  }
  export interface ProgressProps {
    label: string,
    value: number,
    maximum: number,
  }
  export interface ButtonProps {
    label: string,
    actionId: Id,
    tone: UiTone,
    icon?: Id,
  }
  export interface InputProps {
    label: string,
    actionId: Id,
    value: ScalarValue,
    options: Array<ScalarNamedValue>,
  }
  export interface TaskListProps {
    taskIds: Array<Id>,
  }
  export type UiContent = UiContentStack | UiContentRow | UiContentHeading | UiContentText | UiContentBadge | UiContentMetric | UiContentProgress | UiContentButton | UiContentTextInput | UiContentNumberInput | UiContentSelect | UiContentToggle | UiContentTaskList | UiContentTaskRef | UiContentDivider | UiContentEmptyState | UiContentErrorState;
  export interface UiContentStack {
    tag: 'stack',
    val: LayoutProps,
  }
  export interface UiContentRow {
    tag: 'row',
    val: LayoutProps,
  }
  export interface UiContentHeading {
    tag: 'heading',
    val: TextProps,
  }
  export interface UiContentText {
    tag: 'text',
    val: TextProps,
  }
  export interface UiContentBadge {
    tag: 'badge',
    val: TextProps,
  }
  export interface UiContentMetric {
    tag: 'metric',
    val: MetricProps,
  }
  export interface UiContentProgress {
    tag: 'progress',
    val: ProgressProps,
  }
  export interface UiContentButton {
    tag: 'button',
    val: ButtonProps,
  }
  export interface UiContentTextInput {
    tag: 'text-input',
    val: InputProps,
  }
  export interface UiContentNumberInput {
    tag: 'number-input',
    val: InputProps,
  }
  export interface UiContentSelect {
    tag: 'select',
    val: InputProps,
  }
  export interface UiContentToggle {
    tag: 'toggle',
    val: InputProps,
  }
  export interface UiContentTaskList {
    tag: 'task-list',
    val: TaskListProps,
  }
  export interface UiContentTaskRef {
    tag: 'task-ref',
    val: Id,
  }
  export interface UiContentDivider {
    tag: 'divider',
  }
  export interface UiContentEmptyState {
    tag: 'empty-state',
    val: TextProps,
  }
  export interface UiContentErrorState {
    tag: 'error-state',
    val: TextProps,
  }
  export interface UiNode {
    id: Id,
    parentIndex?: number,
    content: UiContent,
  }
  export interface Surface {
    surfaceId: Id,
    rootIndex: number,
    nodes: Array<UiNode>,
  }
  export interface SurfaceRequest {
    surfaceId: Id,
  }
  export interface SurfaceAction {
    surfaceId: Id,
    actionId: Id,
    values: Array<ScalarNamedValue>,
  }
  export type SettingValue = SettingValueText | SettingValueInteger | SettingValueBoolean | SettingValueOptionId;
  export interface SettingValueText {
    tag: 'text',
    val: string,
  }
  export interface SettingValueInteger {
    tag: 'integer',
    val: bigint,
  }
  export interface SettingValueBoolean {
    tag: 'boolean',
    val: boolean,
  }
  export interface SettingValueOptionId {
    tag: 'option-id',
    val: Id,
  }
  export interface NamedSetting {
    id: Id,
    value: SettingValue,
  }
  export interface ValidationIssue {
    settingId: Id,
    message: string,
  }
  export interface SettingValues {
    values: Array<NamedSetting>,
  }
  export interface ServiceCall {
    pluginId: Id,
    serviceId: Id,
    values: Array<NamedValue>,
  }
  export interface ServiceData {
    values: Array<NamedValue>,
  }
  /**
   * # Variants
   *
   * ## `"task"`
   *
   * ## `"project"`
   *
   * ## `"tag"`
   */
  export type ResourceKind = 'task' | 'project' | 'tag';
  export type SnapshotRecords = SnapshotRecordsTasks | SnapshotRecordsProjects | SnapshotRecordsTags;
  export interface SnapshotRecordsTasks {
    tag: 'tasks',
    val: Array<TaskView>,
  }
  export interface SnapshotRecordsProjects {
    tag: 'projects',
    val: Array<ProjectViewRecord>,
  }
  export interface SnapshotRecordsTags {
    tag: 'tags',
    val: Array<TagView>,
  }
  export interface SnapshotPage {
    sessionId: Id,
    eventEpoch: Id,
    headRevision: bigint,
    kind: ResourceKind,
    pageIndex: number,
    records: SnapshotRecords,
    finalSnapshotPage: boolean,
  }
  export interface FlushStagedKv {
    sessionId: Id,
    requestIndex: number,
  }
  export interface FinalizeResync {
    sessionId: Id,
  }
  export type ResyncPage = ResyncPageSnapshot | ResyncPageFlushStagedKv | ResyncPageFinalize;
  export interface ResyncPageSnapshot {
    tag: 'snapshot',
    val: SnapshotPage,
  }
  export interface ResyncPageFlushStagedKv {
    tag: 'flush-staged-kv',
    val: FlushStagedKv,
  }
  export interface ResyncPageFinalize {
    tag: 'finalize',
    val: FinalizeResync,
  }
  export interface KvSegment {
    operations: Array<KvOperation>,
  }
  /**
   * # Variants
   *
   * ## `"more"`
   *
   * ## `"complete"`
   */
  export type FlushState = 'more' | 'complete';
  /**
   * # Variants
   *
   * ## `"leave-kv"`
   *
   * ## `"replace-kv-with-staged-segments"`
   */
  export type FinalKvChoice = 'leave-kv' | 'replace-kv-with-staged-segments';
  export interface SnapshotAck {
    sessionId: Id,
    pageIndex: number,
    kind: ResourceKind,
    segment?: KvSegment,
  }
  export interface FlushAck {
    sessionId: Id,
    requestIndex: number,
    segment?: KvSegment,
    state: FlushState,
  }
  export interface FinalizedResync {
    sessionId: Id,
    choice: FinalKvChoice,
  }
  export type ResyncPageOutcome = ResyncPageOutcomeSnapshotAck | ResyncPageOutcomeFlushAck | ResyncPageOutcomeFinalized;
  export interface ResyncPageOutcomeSnapshotAck {
    tag: 'snapshot-ack',
    val: SnapshotAck,
  }
  export interface ResyncPageOutcomeFlushAck {
    tag: 'flush-ack',
    val: FlushAck,
  }
  export interface ResyncPageOutcomeFinalized {
    tag: 'finalized',
    val: FinalizedResync,
  }
  /**
   * # Variants
   *
   * ## `"get"`
   *
   * ## `"post"`
   *
   * ## `"put"`
   *
   * ## `"patch"`
   *
   * ## `"delete"`
   */
  export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
  export interface HttpHeader {
    name: string,
    value: string,
  }
  export interface HttpRequest {
    method: HttpMethod,
    origin: string,
    pathAndQuery: string,
    headers: Array<HttpHeader>,
    body: Uint8Array,
  }
  export interface HttpResponse {
    status: number,
    headers: Array<HttpHeader>,
    body: Uint8Array,
    truncated: boolean,
  }
  /**
   * # Variants
   *
   * ## `"invalid-request"`
   *
   * ## `"invalid-response"`
   *
   * ## `"permission-denied"`
   *
   * ## `"dns-denied"`
   *
   * ## `"tls-failed"`
   *
   * ## `"connect-failed"`
   *
   * ## `"timeout"`
   *
   * ## `"delivery-ambiguous"`
   *
   * ## `"unavailable"`
   */
  export type HttpErrorCode = 'invalid-request' | 'invalid-response' | 'permission-denied' | 'dns-denied' | 'tls-failed' | 'connect-failed' | 'timeout' | 'delivery-ambiguous' | 'unavailable';
  /**
   * # Variants
   *
   * ## `"not-sent"`
   *
   * ## `"may-have-been-sent"`
   *
   * ## `"response-received"`
   */
  export type DeliveryState = 'not-sent' | 'may-have-been-sent' | 'response-received';
  export interface HttpError {
    code: HttpErrorCode,
    delivery: DeliveryState,
    retryable: boolean,
    message: string,
  }
  export interface LogField {
    name: Id,
    value: ScalarValue,
  }
  export interface KvEntry {
    key: string,
    value: Uint8Array,
  }
  export interface KvPage {
    entries: Array<KvEntry>,
    nextCursor?: string,
  }
}
