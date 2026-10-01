import { z } from 'zod';

export const PUSH_EVENT_TYPES = [
  'investigation_completed',
  'group_update',
  'ranking_changed',
  'invite_activity',
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

export const pushNotificationDataSchema = z
  .object({
    schema: z.literal('oisint.push.v1'),
    eventType: z.enum(PUSH_EVENT_TYPES),
    investigationId: z.string().uuid(),
    notificationId: z.string().uuid(),
    route: z.string().max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.route !== `/investigations/${value.investigationId}`) {
      context.addIssue({
        code: 'custom',
        message: 'route does not match investigationId',
        path: ['route'],
      });
    }
  });

export type PushNotificationData = z.infer<typeof pushNotificationDataSchema>;

export const pushPreferencesSchema = z
  .object({
    notificationsEnabled: z.boolean(),
    groupUpdatesEnabled: z.boolean(),
    permissionStatus: z.enum(['not_requested', 'granted', 'denied']),
  })
  .strict();

export type PushPreferences = z.infer<typeof pushPreferencesSchema>;

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = Object.freeze({
  notificationsEnabled: false,
  groupUpdatesEnabled: true,
  permissionStatus: 'not_requested',
});

export function parsePushNotificationData(value: unknown): PushNotificationData | null {
  const result = pushNotificationDataSchema.safeParse(value);
  return result.success ? result.data : null;
}

export interface PushIdentityProvider {
  login(externalId: string): void | Promise<void>;
  logout(): void | Promise<void>;
}

/**
 * OneSignal external_id の切替を直列化する。A→Bでは必ずAをlogoutしてからBへloginし、
 * 同一端末で旧アカウント宛の通知が残る時間を作らない。
 */
export class PushIdentityController {
  private currentExternalId: string | null = null;
  private identityLinkUncertain = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly provider: PushIdentityProvider) {}

  sync(nextExternalId: string | null): Promise<void> {
    // 前回SDK呼出しが失敗してもqueueをpoisonしたままにせず、次のlogoutで回復できるようにする。
    this.queue = this.queue.catch(() => undefined).then(async () => {
      if (this.currentExternalId === nextExternalId && !this.identityLinkUncertain) return;
      if (this.currentExternalId !== null || this.identityLinkUncertain) {
        await this.provider.logout();
        this.currentExternalId = null;
        this.identityLinkUncertain = false;
      }
      if (nextExternalId !== null) {
        // SDKがidentityを結び付けた後で例外を返す可能性もあるため、呼出し前にunknown状態へ置く。
        this.identityLinkUncertain = true;
        await this.provider.login(nextExternalId);
        this.currentExternalId = nextExternalId;
        this.identityLinkUncertain = false;
      }
    });
    return this.queue;
  }

  current(): string | null {
    return this.currentExternalId;
  }
}
