import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BrowserWindow, shell } from 'electron';
import { getProviderDefaultModel } from './provider-registry';
import { logger } from './logger';
import { saveOAuthTokenToOpenClaw } from './openclaw-auth';
import { getOpenClawResolvedDir } from './paths';
import { getProvider, saveProvider, type ProviderConfig } from './secure-storage';

export const OPENAI_CODEX_PROVIDER_TYPE = 'openai-codex' as const;
export type OpenAICodexProviderType = typeof OPENAI_CODEX_PROVIDER_TYPE;

type OpenAICodexCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
};

type LoginOpenAICodex = (options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
}) => Promise<OpenAICodexCredentials>;

const OAUTH_CANCELLED_MESSAGE = 'OAuth flow cancelled';

class OpenAICodexOAuthManager extends EventEmitter {
  private active = false;
  private mainWindow: BrowserWindow | null = null;
  private manualInputPromise: Promise<string> | null = null;
  private manualInputResolve: ((value: string) => void) | null = null;
  private manualInputReject: ((reason?: unknown) => void) | null = null;
  private queuedManualInput: string | null = null;

  setWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  isActive(): boolean {
    return this.active;
  }

  async startFlow(): Promise<boolean> {
    if (this.active) {
      await this.stopFlow();
    }

    this.active = true;
    this.clearManualInputState();
    this.emit('oauth:start', { provider: OPENAI_CODEX_PROVIDER_TYPE });

    try {
      const loginOpenAICodex = this.loadLoginOpenAICodex();
      const creds = await loginOpenAICodex({
        onAuth: ({ url, instructions }) => {
          logger.info('[OpenAICodexOAuth] Browser auth ready');
          shell.openExternal(url).catch((error) => {
            logger.warn('[OpenAICodexOAuth] Failed to open browser automatically:', error);
          });
          this.emitAuth({
            provider: OPENAI_CODEX_PROVIDER_TYPE,
            authorizationUrl: url,
            instructions,
            canPasteRedirect: true,
          });
          this.emitProgress('Waiting for browser callback or pasted redirect URL');
        },
        onPrompt: async () => this.waitForManualInput(),
        onProgress: (message) => this.emitProgress(message),
        onManualCodeInput: async () => this.waitForManualInput(),
      });

      if (!this.active) return false;

      await this.onSuccess(creds);
      return true;
    } catch (error) {
      if (this.isCancellationError(error)) {
        logger.info('[OpenAICodexOAuth] Flow cancelled');
        return false;
      }

      logger.error('[OpenAICodexOAuth] Flow failed:', error);
      this.emitError(error instanceof Error ? error.message : String(error));
      this.active = false;
      return false;
    } finally {
      this.rejectPendingManualInput(new Error(OAUTH_CANCELLED_MESSAGE));
      this.clearManualInputState();
    }
  }

  async submitManualInput(input: string): Promise<void> {
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      throw new Error('Redirect URL is required');
    }
    if (!this.active) {
      throw new Error('No active OpenAI Codex OAuth flow');
    }

    if (this.manualInputResolve) {
      const resolve = this.manualInputResolve;
      this.clearManualInputState();
      resolve(trimmedInput);
      return;
    }

    this.queuedManualInput = trimmedInput;
  }

  async stopFlow(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.rejectPendingManualInput(new Error(OAUTH_CANCELLED_MESSAGE));
    this.clearManualInputState();
  }

  private loadLoginOpenAICodex(): LoginOpenAICodex {
    const requireFromOpenClaw = createRequire(`${getOpenClawResolvedDir()}/package.json`);
    const piAi = requireFromOpenClaw('@mariozechner/pi-ai') as {
      loginOpenAICodex?: LoginOpenAICodex;
    };

    if (typeof piAi.loginOpenAICodex !== 'function') {
      throw new Error('OpenAI Codex OAuth is unavailable in the bundled OpenClaw runtime');
    }

    return piAi.loginOpenAICodex;
  }

  private waitForManualInput(): Promise<string> {
    if (!this.active) {
      return Promise.reject(new Error(OAUTH_CANCELLED_MESSAGE));
    }

    if (this.queuedManualInput) {
      const input = this.queuedManualInput;
      this.queuedManualInput = null;
      return Promise.resolve(input);
    }

    if (this.manualInputPromise) {
      return this.manualInputPromise;
    }

    this.manualInputPromise = new Promise<string>((resolve, reject) => {
      this.manualInputResolve = resolve;
      this.manualInputReject = reject;
    });

    return this.manualInputPromise;
  }

  private async onSuccess(credentials: OpenAICodexCredentials): Promise<void> {
    this.active = false;

    await saveOAuthTokenToOpenClaw(OPENAI_CODEX_PROVIDER_TYPE, credentials);

    const existing = await getProvider(OPENAI_CODEX_PROVIDER_TYPE);
    const providerConfig: ProviderConfig = {
      id: OPENAI_CODEX_PROVIDER_TYPE,
      name: existing?.name || 'OpenAI Codex',
      type: OPENAI_CODEX_PROVIDER_TYPE,
      enabled: existing?.enabled ?? true,
      baseUrl: existing?.baseUrl,
      model: existing?.model || getProviderDefaultModel(OPENAI_CODEX_PROVIDER_TYPE),
      fallbackModels: existing?.fallbackModels,
      fallbackProviderIds: existing?.fallbackProviderIds,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveProvider(providerConfig);

    this.emit('oauth:success', OPENAI_CODEX_PROVIDER_TYPE);
    this.sendToRenderer('oauth:success', { provider: OPENAI_CODEX_PROVIDER_TYPE, success: true });
  }

  private emitAuth(payload: {
    provider: OpenAICodexProviderType;
    authorizationUrl: string;
    instructions?: string;
    canPasteRedirect: boolean;
  }): void {
    this.emit('oauth:auth', payload);
    this.sendToRenderer('oauth:auth', payload);
  }

  private emitProgress(message: string): void {
    const payload = { provider: OPENAI_CODEX_PROVIDER_TYPE, message };
    this.emit('oauth:progress', payload);
    this.sendToRenderer('oauth:progress', payload);
  }

  private emitError(message: string): void {
    this.sendToRenderer('oauth:error', {
      provider: OPENAI_CODEX_PROVIDER_TYPE,
      message,
    });
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(channel, payload);
  }

  private rejectPendingManualInput(reason: Error): void {
    if (!this.manualInputReject) return;
    const reject = this.manualInputReject;
    this.clearManualInputState();
    reject(reason);
  }

  private clearManualInputState(): void {
    this.manualInputPromise = null;
    this.manualInputResolve = null;
    this.manualInputReject = null;
    this.queuedManualInput = null;
  }

  private isCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message === OAUTH_CANCELLED_MESSAGE;
  }
}

export const openAICodexOAuthManager = new OpenAICodexOAuthManager();
