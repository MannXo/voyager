import {
  getSafariMajorVersion,
  getVoyagerBuildTarget,
  hasLegacySafariStorageLimit,
} from '@/core/utils/browser';

import type {
  EffectiveLocalQuota,
  StorageAreaUsage,
  StorageQuotaServiceDependencies,
  UnlimitedStoragePermissionReason,
  UnlimitedStoragePermissionRequestReason,
  UnlimitedStoragePermissionRequestResult,
  UnlimitedStoragePermissionStatus,
} from './StorageQuotaService';

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

const lowerQuota = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StorageQuotaPolicyOptions extends Pick<
  StorageQuotaServiceDependencies,
  'buildTarget' | 'userAgent' | 'safariMajorVersion' | 'legacySafariStorageLimit'
> {
  chromeApi: () => NonNullable<StorageQuotaServiceDependencies['chromeApi']>;
  callApi: <T>(
    owner: object,
    method: ((...args: unknown[]) => unknown) | undefined,
    args: unknown[],
  ) => Promise<T>;
}

/** Owns browser permission prompts and conservative platform quota limits. */
export class StorageQuotaPolicy {
  constructor(private readonly options: StorageQuotaPolicyOptions) {}

  private get chromeApi() {
    return this.options.chromeApi();
  }

  private get runtime() {
    return this.chromeApi.runtime;
  }

  private detectBrowser(): UnlimitedStoragePermissionStatus['browser'] {
    const target = this.options.buildTarget?.() ?? getVoyagerBuildTarget();
    const ua = this.options.userAgent?.() ?? globalThis.navigator?.userAgent ?? '';
    if (target === 'firefox' || /firefox/i.test(ua)) return 'firefox';
    if (target === 'safari') return 'safari';
    if (target === 'chrome' || target === 'edge' || /(?:chrome|chromium|edg)/i.test(ua)) {
      return 'chromium';
    }
    return 'unknown';
  }

  async getStatus(): Promise<UnlimitedStoragePermissionStatus> {
    const browser = this.detectBrowser();
    const permissionsApi = this.chromeApi.permissions;
    const manifest = this.runtime?.getManifest?.() ?? {};
    const required = (manifest.permissions ?? []).includes('unlimitedStorage');
    const declared = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ].includes('unlimitedStorage');

    if (required) {
      return {
        supported: true,
        declared: true,
        granted: true,
        requestable: false,
        browser,
        reason: 'already-granted',
      };
    }
    if (browser === 'firefox') {
      return {
        supported: true,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'not-declared',
      };
    }
    if (!permissionsApi?.contains || !permissionsApi.request) {
      return {
        supported: false,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'unsupported-api',
      };
    }

    let granted = false;
    try {
      granted =
        (await this.options.callApi<boolean>(permissionsApi, permissionsApi.contains, [
          { permissions: ['unlimitedStorage'] },
        ])) === true;
    } catch {
      // A missing/older permissions implementation behaves as unsupported.
      return {
        supported: false,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: 'unsupported-api',
      };
    }

    return {
      supported: true,
      declared,
      granted,
      requestable: declared && !granted,
      browser,
      reason: granted ? 'already-granted' : declared ? 'available' : 'not-declared',
    };
  }

  async request(): Promise<UnlimitedStoragePermissionRequestResult> {
    // Keep all gating synchronous. Browser permission prompts require a live
    // user gesture, which would be lost by awaiting contains() first.
    const browser = this.detectBrowser();
    const permissionsApi = this.chromeApi.permissions;
    const manifest = this.runtime?.getManifest?.() ?? {};
    const required = (manifest.permissions ?? []).includes('unlimitedStorage');
    const declared = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ].includes('unlimitedStorage');
    if (required || browser === 'firefox') {
      const status = await this.getStatus();
      return {
        requested: false,
        granted: status.granted,
        reason: status.granted ? 'already-granted' : 'not-declared',
        status,
      };
    }

    const unsupportedReason: UnlimitedStoragePermissionReason = !declared
      ? 'not-declared'
      : 'unsupported-api';
    if (!declared || !permissionsApi?.request) {
      const status: UnlimitedStoragePermissionStatus = {
        supported: !!permissionsApi?.contains && !!permissionsApi?.request,
        declared,
        granted: false,
        requestable: false,
        browser,
        reason: unsupportedReason,
      };
      const reason: UnlimitedStoragePermissionRequestReason =
        unsupportedReason === 'not-declared' ? 'not-declared' : 'unsupported-api';
      return { requested: false, granted: false, reason, status };
    }

    try {
      // This must remain the first await in the supported path.
      const granted =
        (await this.options.callApi<boolean>(permissionsApi, permissionsApi.request, [
          { permissions: ['unlimitedStorage'] },
        ])) === true;
      const status = await this.getStatus();
      return {
        requested: true,
        granted,
        reason: granted ? 'granted' : 'denied',
        status,
      };
    } catch (error) {
      const status = await this.getStatus();
      return {
        requested: true,
        granted: false,
        reason: 'error',
        status,
        error: errorMessage(error),
      };
    }
  }

  /** An estimated area limit stays below the fixed rule previously used by highlights. */
  localQuota(unlimitedGranted: boolean): EffectiveLocalQuota {
    const declared = this.chromeApi.storage?.local?.QUOTA_BYTES;
    const area = this.resolveLocalQuota(declared, unlimitedGranted);
    if (!area.quotaEstimated) return { quotaBytes: area.quotaBytes, estimated: false };
    const flat = this.flatLocalQuota(declared, unlimitedGranted);
    return { quotaBytes: lowerQuota(area.quotaBytes, flat), estimated: true };
  }

  private flatLocalQuota(declared: number | undefined, unlimitedGranted: boolean): number | null {
    const browser = this.detectBrowser();
    if (unlimitedGranted) {
      if (browser !== 'safari') return null;
      const major = this.options.safariMajorVersion?.() ?? getSafariMajorVersion();
      return major !== null && major >= 16 ? null : 10 * MEBIBYTE;
    }
    if (typeof declared === 'number' && declared > 0) return declared;
    return browser === 'firefox' || browser === 'safari' ? 5 * MEBIBYTE : 10 * MEBIBYTE;
  }

  syncQuota(
    declaredQuota: number | undefined,
  ): Pick<StorageAreaUsage, 'quotaBytes' | 'quotaEstimated'> {
    return typeof declaredQuota === 'number' && declaredQuota > 0
      ? { quotaBytes: declaredQuota, quotaEstimated: false }
      : { quotaBytes: 100 * KIBIBYTE, quotaEstimated: true };
  }

  private resolveLocalQuota(
    declaredQuota: number | undefined,
    unlimitedGranted: boolean,
  ): Pick<StorageAreaUsage, 'quotaBytes' | 'quotaEstimated'> {
    if (this.detectBrowser() === 'safari') {
      if (!unlimitedGranted) return { quotaBytes: 5 * MEBIBYTE, quotaEstimated: false };

      const majorVersion = this.options.safariMajorVersion?.() ?? getSafariMajorVersion();
      const hasLegacyLimit =
        this.options.legacySafariStorageLimit?.() ?? hasLegacySafariStorageLimit();
      if (hasLegacyLimit || (majorVersion !== null && majorVersion < 16)) {
        return { quotaBytes: 10 * MEBIBYTE, quotaEstimated: false };
      }
      if (majorVersion !== null && majorVersion >= 16) {
        return { quotaBytes: null, quotaEstimated: false };
      }

      return typeof declaredQuota === 'number' && declaredQuota > 0
        ? { quotaBytes: declaredQuota, quotaEstimated: true }
        : { quotaBytes: null, quotaEstimated: true };
    }

    if (unlimitedGranted) return { quotaBytes: null, quotaEstimated: false };
    return typeof declaredQuota === 'number' && declaredQuota > 0
      ? { quotaBytes: declaredQuota, quotaEstimated: false }
      : { quotaBytes: 10 * MEBIBYTE, quotaEstimated: true };
  }
}
