import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull().default('New Chat'),
  starred: integer('starred').notNull().default(0),
  chatMode: text('chat_mode').notNull().default('agent'),
  codeWorkspaceId: text('code_workspace_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  notification: text('notification').notNull(),
  payload: text('payload').notNull(),
  read: integer('read').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  channelId: text('channel_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const codeWorkspaces = sqliteTable('code_workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  containerName: text('container_name').unique(),
  repo: text('repo'),
  branch: text('branch'),
  featureBranch: text('feature_branch'),
  title: text('title').notNull().default('Code Workspace'),
  lastInteractiveCommit: text('last_interactive_commit'),
  starred: integer('starred').notNull().default(0),
  hasChanges: integer('has_changes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const clusters = sqliteTable('clusters', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull().default('New Cluster'),
  systemPrompt: text('system_prompt').notNull().default(''),
  folders: text('folders'),
  enabled: integer('enabled').notNull().default(0),
  starred: integer('starred').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const clusterRoles = sqliteTable('cluster_roles', {
  id: text('id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  roleName: text('role_name').notNull(),
  role: text('role').notNull().default(''),
  prompt: text('prompt').notNull().default('Execute your role.'),
  triggerConfig: text('trigger_config'),
  maxConcurrency: integer('max_concurrency').notNull().default(1),
  cleanupWorkerDir: integer('cleanup_worker_dir').notNull().default(0),
  planMode: integer('plan_mode').notNull().default(0),
  folders: text('folders'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdBy: text('created_by'),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// --- Conclave: multi-node fleet ---

// A registered remote worker node (Mac mini, Windows box, Linux host).
// Nodes dial out to the central server over WebSocket and authenticate
// with a bearer token whose hash is stored here.
export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  os: text('os'),                            // 'darwin' | 'win32' | 'linux'
  runtimes: text('runtimes').notNull().default('[]'),  // JSON: ['claude-cli','openclaw','docker']
  labels: text('labels').notNull().default('[]'),      // JSON string array
  capacity: integer('capacity').notNull().default(1),  // max concurrent jobs
  status: text('status').notNull().default('offline'), // 'online' | 'offline' | 'draining'
  lastSeen: integer('last_seen'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// One row per attempt to run a job on a specific node. The job itself
// (agent-job branch, cluster role invocation, etc.) lives in its existing
// table or in git; this table just records the dispatch + outcome.
export const jobAssignments = sqliteTable('job_assignments', {
  id: text('id').primaryKey(),
  jobKey: text('job_key').notNull(),         // foreign key to whatever produced this job (agentJobId, cluster session id, etc.)
  jobKind: text('job_kind').notNull(),       // 'agent-job' | 'cluster-role' | 'command' | 'interactive'
  nodeId: text('node_id').notNull(),
  runtime: text('runtime').notNull(),        // which adapter on the node ran it
  status: text('status').notNull().default('pending'), // pending|running|succeeded|failed|cancelled
  exitCode: integer('exit_code'),
  error: text('error'),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  createdAt: integer('created_at').notNull(),
});
