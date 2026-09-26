// The API layer (plan §9): typed client, ApiError, error policy, query keys, and TanStack Query
// hooks per area. Import from '@/api'.
import './queryMeta';

export { api, createApiClient, defaultBaseUrl, unwrap, type ApiClient, type ApiClientOptions, type CallOptions } from './client';
export {
  ApiError,
  DEFAULT_ERROR_TITLES,
  defaultErrorTitle,
  isAbortError,
  isApiError,
  parseRetryAfter,
  type ApiErrorInit,
  type ApiErrorKind,
} from './errors';
export {
  applyErrorPolicy,
  classifyApiError,
  describeApiError,
  ERROR_TOAST_DURATION_MS,
  errorPageData,
  errorToastId,
  isTransientError,
  retryDelay,
  shouldRetryQuery,
  type ApiRequestMeta,
  type ErrorHandling,
  type ErrorPageData,
  type ErrorPolicy,
  type ErrorPolicyContext,
  type ErrorToast,
} from './errorPolicy';
export { onSignInRequired, requestSignIn, type SignInRequiredEvent } from './events';
export { encodeJsonBody, GZIP_MIN_BYTES, jsonBodyOptions, type EncodedJsonBody, type EncodeJsonOptions, type GzipMode } from './gzip';
export { mergeMutationOptions, type MutationOverrides, type QueryOverrides } from './hookOptions';
export { mutationKeys, normalizeHandle, normalizeVaultParams, queryKeys } from './keys';
export type * from './types';

export {
  accountQueries,
  changePassword,
  fetchMe,
  login,
  loginFailure,
  logout,
  register,
  setHandle,
  useChangePassword,
  useLogin,
  useLogout,
  useMe,
  useRegister,
  useSetHandle,
  type ChangePasswordVariables,
  type LoginFailure,
  type LoginVariables,
} from './account';
export {
  brewQueries,
  cloneBrew,
  createBrew,
  deleteBrew,
  fetchBrewForEdit,
  fetchBrewForShare,
  requestLockReview,
  saveBrew,
  useBrewForEdit,
  useBrewForShare,
  useCloneBrew,
  useCreateBrew,
  useDeleteBrew,
  useRequestLockReview,
  useSaveBrew,
  type BodyCallOptions,
  type SaveBrewVariables,
  type SaveCallOptions,
} from './brews';
export { fetchThemeBundle, fetchThemes, themeQueries, useThemeBundle, useThemes } from './themes';
export { fetchUserBrews, listQueries, searchVault, useUserBrews, useVaultSearch } from './lists';
export { fetchActiveNotifications, notificationQueries, useActiveNotifications } from './notifications';
export { fetchUpstreamBrew, parseUpstreamShareId, UPSTREAM_SHARE_ID, useUpstreamImport } from './importUpstream';
export {
  adminQueries,
  createNotification,
  deleteNotification,
  dismissLockReview,
  fetchAdminBrew,
  fetchAdminLocks,
  fetchAdminNotification,
  fetchAdminNotifications,
  fetchAdminReviewQueue,
  fetchAdminStats,
  findAdminUsers,
  lockBrew,
  unlockBrew,
  updateNotification,
  useAdminBrew,
  useAdminCreateNotification,
  useAdminDeleteNotification,
  useAdminDismissReview,
  useAdminLockBrew,
  useAdminLocks,
  useAdminNotification,
  useAdminNotifications,
  useAdminReviewQueue,
  useAdminStats,
  useAdminUnlockBrew,
  useAdminUpdateNotification,
  useAdminUsers,
  type LockBrewVariables,
  type UpdateNotificationVariables,
} from './admin';
