import { ServerConnections } from 'lib/jellyfin-apiclient';
import globalize from '../../lib/globalize';
import toast from '../toast/toast';
import './clipRecorder.scss';

export class ClipRecorder {
    private startTimeTicks: number | null = null;
    private recording = false;
    private itemId: string | null = null;
    private serverId: string | null = null;
    private subtitleStreamIndex: number | null = null;
    private indicatorElement: HTMLElement | null = null;
    private onStateChange: ((recording: boolean) => void) | null;

    constructor(onStateChange?: (recording: boolean) => void) {
        this.onStateChange = onStateChange || null;
    }

    start(currentTimeTicks: number, itemId: string, serverId: string, subtitleStreamIndex?: number | null): void {
        this.startTimeTicks = currentTimeTicks;
        this.itemId = itemId;
        this.serverId = serverId;
        this.subtitleStreamIndex = subtitleStreamIndex ?? null;
        this.recording = true;
        this.showIndicator();
        this.onStateChange?.(true);
    }

    async stop(currentTimeTicks: number): Promise<void> {
        if (!this.recording || this.startTimeTicks === null || !this.itemId || !this.serverId) {
            return;
        }

        const startTicks = this.startTimeTicks;
        const endTicks = currentTimeTicks;
        const itemId = this.itemId;
        const serverId = this.serverId;
        const subtitleStreamIndex = this.subtitleStreamIndex;

        this.recording = false;
        this.startTimeTicks = null;
        this.subtitleStreamIndex = null;
        this.hideIndicator();
        this.onStateChange?.(false);

        if (endTicks <= startTicks) {
            toast(globalize.translate('ClipNotSupported'));
            return;
        }

        try {
            const apiClient = ServerConnections.getApiClient(serverId);
            const params: Record<string, string> = {
                itemId: itemId,
                startTicks: startTicks.toString(),
                endTicks: endTicks.toString()
            };

            if (subtitleStreamIndex != null && subtitleStreamIndex >= 0) {
                params.subtitleStreamIndex = subtitleStreamIndex.toString();
            }

            const url = apiClient.getUrl('Clips', params);

            await apiClient.ajax({
                type: 'POST',
                url: url
            });

            toast(globalize.translate('ClipProcessing'));
        } catch (e) {
            console.error('Failed to create clip:', e);
            toast(globalize.translate('ClipNotSupported'));
        }
    }

    isRecording(): boolean {
        return this.recording;
    }

    destroy(): void {
        this.recording = false;
        this.startTimeTicks = null;
        this.hideIndicator();
        this.onStateChange = null;
    }

    private showIndicator(): void {
        if (this.indicatorElement) {
            return;
        }

        const el = document.createElement('div');
        el.classList.add('clipRecordingIndicator');
        el.innerHTML = '<span class="clipRecDot"></span><span>REC</span>';
        document.body.appendChild(el);
        this.indicatorElement = el;
    }

    private hideIndicator(): void {
        if (this.indicatorElement) {
            this.indicatorElement.remove();
            this.indicatorElement = null;
        }
    }
}
