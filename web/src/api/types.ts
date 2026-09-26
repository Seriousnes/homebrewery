// Named aliases for the generated OpenAPI schemas (web/src/api/schema.d.ts is generated; never
// edit it — regenerate with `npm run api:types`).
import type { components, operations } from './schema';

export type Schemas = components['schemas'];

// Account
export type AccountInfo = Schemas['AccountInfo'];
export type RegisterRequest = Schemas['RegisterRequest'];
export type LoginRequest = Schemas['LoginRequest'];
export type SetHandleRequest = Schemas['SetHandleRequest'];

// Brews
export type AuthorRole = Schemas['AuthorRole'];
export type BrewAuthorInfo = Schemas['BrewAuthorInfo'];
export type BrewMeta = Schemas['BrewMeta'];
export type BrewMetaInput = Schemas['BrewMetaInput'];
export type BrewLockInfo = Schemas['BrewLockInfo'];
export type BrewForEdit = Schemas['BrewForEdit'];
export type BrewForShare = Schemas['BrewForShare'];
export type BrewSummary = Schemas['BrewSummary'];
export type CreateBrewRequest = Schemas['CreateBrewRequest'];
export type SaveBrewRequest = Schemas['SaveBrewRequest'];
export type SaveBrewResponse = Schemas['SaveBrewResponse'];
export type SaveConflict = Schemas['SaveConflict'];
export type DeleteBrewResponse = Schemas['DeleteBrewResponse'];

// Themes
export type ThemeList = Schemas['ThemeList'];
export type ThemeCatalogEntry = Schemas['ThemeCatalogEntry'];
export type UserThemeInfo = Schemas['UserThemeInfo'];
export type ThemeBundle = Schemas['ThemeBundle'];
export type ThemeBundleStyle = Schemas['ThemeStyle'];
export type ThemeBundleSnippetRef = Schemas['ThemeSnippetRef'];

// Vault and user lists
export type VaultPage = Schemas['VaultPage'];
export type VaultSearchParams = NonNullable<operations['SearchVault']['parameters']['query']>;
export type VaultSort = NonNullable<VaultSearchParams['sort']>;
export type VaultDir = NonNullable<VaultSearchParams['dir']>;
export type UserBrewList = Schemas['UserBrewList'];

// Notifications
export type NotificationInfo = Schemas['NotificationInfo'];
export type NotificationInput = Schemas['NotificationInput'];

// Admin
export type AdminStats = Schemas['AdminStats'];
export type AdminUserInfo = Schemas['AdminUserInfo'];
export type AdminBrewInfo = Schemas['AdminBrewInfo'];
export type AdminLockInfo = Schemas['AdminLockInfo'];
export type LockedBrewInfo = Schemas['LockedBrewInfo'];
export type LockRequest = Schemas['LockRequest'];

// Problems
export type ProblemDetails = Schemas['ProblemDetails'];
export type ValidationProblemDetails = Schemas['HttpValidationProblemDetails'];
