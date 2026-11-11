import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { EventType } from 'constants/eventType';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';

import './studySubtitles.scss';

export interface StudyDictionaryEntry {
    Traditional: string;
    Simplified: string;
    Pinyin: string;
    Definitions: string[];
}

export interface StudyWord {
    Text: string;
    IsWord: boolean;
    Pinyin?: string | null;
    Gloss?: string | null;
    Entries: StudyDictionaryEntry[];
}

export interface StudyLine {
    StartPositionTicks: number;
    EndPositionTicks: number;
    Text: string;
    Translation?: string | null;
    Notes?: string | null;
    Words: StudyWord[];
}

export interface StudySubtitlesData {
    Source: 'Sidecar' | 'Generated';
    BurnedInSubtitleTop?: number | null;
    Lines: StudyLine[];
}

/** Which layers to show: Chinese is always shown, pinyin and English are optional. */
export type StudyMode = 'off' | 'zh' | 'zh-py' | 'zh-en' | 'all';

export const STUDY_MODES: StudyMode[] = ['off', 'zh', 'zh-py', 'zh-en', 'all'];

const STORAGE_PREFIX = 'studySubtitlesMode-';
const MAX_CARD_ENTRIES = 4;
const MAX_CARD_DEFINITIONS = 6;
const TONE_MARKS: Record<string, number> = {};
['āēīōūǖĀĒĪŌŪǕ', 'áéíóúǘÁÉÍÓÚǗ', 'ǎěǐǒǔǚǍĚǏǑǓǙ', 'àèìòùǜÀÈÌÒÙǛ'].forEach((marks, i) => {
    for (const mark of marks) TONE_MARKS[mark] = i + 1;
});

export function getStudyModeName(mode: StudyMode): string {
    switch (mode) {
        case 'off': return globalize.translate('Off');
        case 'zh': return globalize.translate('StudyModeChinese');
        case 'zh-py': return globalize.translate('StudyModeChinesePinyin');
        case 'zh-en': return globalize.translate('StudyModeChineseEnglish');
        case 'all': return globalize.translate('StudyModeAll');
    }
}

function storageKey(item: BaseItemDto): string {
    return STORAGE_PREFIX + (item.SeriesId || item.Id);
}

export function getStoredStudyMode(item: BaseItemDto): StudyMode {
    try {
        const value = localStorage.getItem(storageKey(item)) as StudyMode | null;
        return value && STUDY_MODES.includes(value) ? value : 'off';
    } catch {
        return 'off';
    }
}

export function storeStudyMode(item: BaseItemDto, mode: StudyMode): void {
    try {
        if (mode === 'off') {
            localStorage.removeItem(storageKey(item));
        } else {
            localStorage.setItem(storageKey(item), mode);
        }
    } catch {
        // Storage unavailable: the mode just won't be remembered.
    }
}

export async function fetchStudySubtitles(item: BaseItemDto, mediaSourceId?: string | null): Promise<StudySubtitlesData | null> {
    const apiClient = ServerConnections.getApiClient(item.ServerId!);
    if (!apiClient || !item.Id) return null;

    const url = apiClient.getUrl(`Videos/${item.Id}/StudySubtitles`, mediaSourceId ? { mediaSourceId } : {});
    try {
        const data = await apiClient.getJSON(url) as StudySubtitlesData;
        return data?.Lines?.length ? data : null;
    } catch (err) {
        console.warn('[StudySubtitles] none available', err);
        return null;
    }
}

function splitSyllables(pinyin: string): string[] {
    return pinyin.split(/\s+/).filter(Boolean);
}

function toneOf(syllable: string): number {
    for (const c of syllable) {
        const tone = TONE_MARKS[c];
        if (tone) return tone;
    }
    return 5;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const elem = document.createElement(tag);
    if (className) elem.className = className;
    if (text != null) elem.textContent = text;
    return elem;
}

function appendTonedPinyin(parent: HTMLElement, pinyin: string) {
    splitSyllables(pinyin).forEach((syllable, i) => {
        if (i > 0) parent.appendChild(document.createTextNode(' '));
        parent.appendChild(el('span', `studyTone${toneOf(syllable)}`, syllable));
    });
}

interface OverlayOptions {
    /** Element to put the overlay in (the video OSD page). */
    container: HTMLElement;
    data: StudySubtitlesData;
    getVideoElement: () => HTMLVideoElement | null;
    /** Height in px of the visible OSD controls, so subtitles can move above them. */
    getOsdHeight: () => number;
    /** Called when the user taps a word while playing, so playback can pause. */
    onRequestPause: () => void;
}

/**
 * Draws study subtitles over the video: Chinese words with optional pinyin (ruby) and English,
 * and a dictionary card for a word, opened by tapping it or (on TV) with the word cursor while paused.
 */
export class StudySubtitleOverlay {
    private readonly options: OverlayOptions;
    private readonly root: HTMLDivElement;
    private readonly mask: HTMLDivElement;
    private readonly lineElem: HTMLDivElement;
    private readonly textElem: HTMLDivElement;
    private readonly translationElem: HTMLDivElement;
    private card: HTMLDivElement | null = null;
    private mode: StudyMode = 'zh';
    private lineIndex = -1;
    private selectedWord = -1;
    private paused = false;
    private osdShown = false;
    private bandTop: number | null = null;
    private readonly hiddenTracks = new Set<TextTrack>();
    private bandHeight = 0;

    constructor(options: OverlayOptions) {
        this.options = options;
        this.root = el('div', 'studySubtitles');
        this.mask = el('div', 'studySubtitlesMask hide');
        this.lineElem = el('div', 'studySubtitlesLine');
        this.textElem = el('div', 'studySubtitlesText');
        this.translationElem = el('div', 'studySubtitlesTranslation');
        this.lineElem.append(this.textElem, this.translationElem);
        this.root.append(this.mask, this.lineElem);
        // First child, so the OSD controls (later siblings) paint over the mask
        options.container.insertBefore(this.root, options.container.firstChild);

        this.textElem.addEventListener('click', this.onTextClick);
        window.addEventListener('resize', this.layout);
        options.getVideoElement()?.addEventListener('loadedmetadata', this.layout);
        Events.on(document, EventType.SHOW_VIDEO_OSD, this.onOsdChanged);
        this.layout();
    }

    setMode(mode: StudyMode): void {
        this.mode = mode;
        this.root.classList.toggle('hide', mode === 'off');
        document.body.classList.toggle('studySubtitlesActive', mode !== 'off');
        if (mode === 'off') {
            this.restoreNativeTracks();
        } else {
            this.hideNativeTracks();
        }
        this.root.classList.toggle('studySubtitles-pinyin', mode === 'zh-py' || mode === 'all');
        this.root.classList.toggle('studySubtitles-english', mode === 'zh-en' || mode === 'all');
        this.layout();
    }

    getMode(): StudyMode {
        return this.mode;
    }

    /** Updates the displayed line for the playback position. */
    update(positionMs: number): void {
        if (this.mode !== 'off') {
            // The player may (re)enable a track at any time, e.g. when the user picks one; keep them hidden.
            this.hideNativeTracks();
        }

        const index = this.findLine(positionMs * 10000);
        if (index !== this.lineIndex) {
            this.lineIndex = index;
            this.closeCard();
            this.selectedWord = -1;
            this.renderLine();
        }
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        this.root.classList.toggle('studySubtitles-interactive', paused);
        if (!paused) {
            this.exitWordMode();
        }
    }

    isInWordMode(): boolean {
        return this.selectedWord >= 0;
    }

    /** Puts the word cursor on the first word of the current line. Returns false if there is nothing to select. */
    enterWordMode(): boolean {
        const words = this.wordIndexes();
        if (!words.length) return false;
        this.select(words[0]);
        return true;
    }

    exitWordMode(): void {
        this.closeCard();
        this.select(-1);
    }

    /**
     * Handles a remote/keyboard key while in word mode.
     * @returns 'handled', 'exit' (word mode was left and focus should go back to the OSD) or 'ignored'.
     */
    handleKey(key: string): 'handled' | 'exit' | 'ignored' {
        if (!this.isInWordMode()) return 'ignored';
        const words = this.wordIndexes();
        const position = words.indexOf(this.selectedWord);
        switch (key) {
            case 'ArrowLeft':
            case 'Left':
                if (position > 0) this.select(words[position - 1], this.card !== null);
                return 'handled';
            case 'ArrowRight':
            case 'Right':
                if (position < words.length - 1) this.select(words[position + 1], this.card !== null);
                return 'handled';
            case 'Enter':
                if (this.card) {
                    this.closeCard();
                } else {
                    this.openCard(this.selectedWord);
                }
                return 'handled';
            case 'ArrowUp':
            case 'Up':
                return 'handled';
            case 'ArrowDown':
            case 'Down':
                this.exitWordMode();
                return 'exit';
            case 'Escape':
            case 'Back':
            case 'Backspace':
                if (this.card) {
                    this.closeCard();
                    return 'handled';
                }
                this.exitWordMode();
                return 'exit';
            default:
                return 'ignored';
        }
    }

    destroy(): void {
        this.closeCard();
        window.removeEventListener('resize', this.layout);
        this.options.getVideoElement()?.removeEventListener('loadedmetadata', this.layout);
        Events.off(document, EventType.SHOW_VIDEO_OSD, this.onOsdChanged);
        document.body.classList.remove('studySubtitlesActive');
        this.restoreNativeTracks();
        this.root.remove();
    }

    /** Hides subtitles the browser draws itself (native text tracks), which CSS cannot reliably hide. */
    private hideNativeTracks(): void {
        const tracks = this.options.getVideoElement()?.textTracks;
        if (!tracks) return;
        // Array.from rather than for-of: older TV browsers' TextTrackList is array-like but not iterable.
        Array.from(tracks).forEach(track => {
            if (track.mode === 'showing') {
                track.mode = 'hidden';
                this.hiddenTracks.add(track);
            }
        });
    }

    private restoreNativeTracks(): void {
        this.hiddenTracks.forEach(track => {
            if (track.mode === 'hidden') track.mode = 'showing';
        });
        this.hiddenTracks.clear();
    }

    private findLine(ticks: number): number {
        const lines = this.options.data.Lines;
        let low = 0;
        let high = lines.length - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (lines[mid].StartPositionTicks <= ticks) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found >= 0 && ticks <= lines[found].EndPositionTicks ? found : -1;
    }

    private get line(): StudyLine | undefined {
        return this.lineIndex >= 0 ? this.options.data.Lines[this.lineIndex] : undefined;
    }

    private wordIndexes(): number[] {
        return (this.line?.Words || []).flatMap((w, i) => (w.IsWord ? [i] : []));
    }

    private renderLine(): void {
        this.textElem.textContent = '';
        const line = this.line;
        this.lineElem.classList.toggle('hide', !line);
        this.translationElem.textContent = line?.Translation || '';
        if (!line) return;

        line.Words.forEach((word, index) => {
            if (!word.IsWord) {
                this.textElem.appendChild(el('span', 'studyPunctuation', word.Text));
                return;
            }

            const span = el('span', 'studyWord');
            span.dataset.index = String(index);
            const chars = Array.from(word.Text);
            const syllables = word.Pinyin ? splitSyllables(word.Pinyin) : [];
            if (syllables.length === chars.length) {
                // One pinyin syllable above each character.
                chars.forEach((c, i) => {
                    const ruby = el('ruby', undefined, c);
                    ruby.appendChild(el('rt', undefined, syllables[i]));
                    span.appendChild(ruby);
                });
            } else {
                const ruby = el('ruby', undefined, word.Text);
                ruby.appendChild(el('rt', undefined, word.Pinyin || ''));
                span.appendChild(ruby);
            }
            this.textElem.appendChild(span);
        });
    }

    private select(index: number, keepCardOpen = false): void {
        this.selectedWord = index;
        this.root.classList.toggle('studySubtitles-wordMode', index >= 0);
        this.textElem.querySelectorAll('.studyWord-selected').forEach(e => {
            e.classList.remove('studyWord-selected');
        });
        if (index >= 0) {
            this.wordElement(index)?.classList.add('studyWord-selected');
            if (keepCardOpen) this.openCard(index);
        }
    }

    private wordElement(index: number): HTMLElement | null {
        return this.textElem.querySelector(`.studyWord[data-index="${index}"]`);
    }

    private readonly onTextClick = (e: MouseEvent) => {
        e.stopPropagation();
        const wordElem = (e.target as HTMLElement).closest<HTMLElement>('.studyWord');
        if (!wordElem) return;
        const index = parseInt(wordElem.dataset.index || '', 10);
        if (isNaN(index)) return;

        if (!this.paused) this.options.onRequestPause();
        if (this.card && this.selectedWord === index) {
            this.exitWordMode();
        } else {
            this.select(index);
            this.openCard(index);
        }
    };

    private openCard(index: number): void {
        const line = this.line;
        const word = line?.Words[index];
        const anchor = this.wordElement(index);
        if (!line || !word || !anchor) return;

        this.closeCard();
        const card = el('div', 'studyWordCard');
        card.addEventListener('click', e => e.stopPropagation());

        const header = el('div', 'studyWordCard-header');
        header.appendChild(el('span', 'studyWordCard-word', word.Text));
        if (word.Pinyin) {
            const pinyin = el('span', 'studyWordCard-pinyin');
            appendTonedPinyin(pinyin, word.Pinyin);
            header.appendChild(pinyin);
        }
        card.appendChild(header);

        if (word.Gloss) {
            card.appendChild(el('div', 'studyWordCard-gloss', word.Gloss));
        }

        const entries = word.Entries.slice(0, MAX_CARD_ENTRIES);
        if (entries.length) {
            const list = el('div', 'studyWordCard-entries');
            entries.forEach(entry => {
                const row = el('div', 'studyWordCard-entry');
                const entryPinyin = el('span', 'studyWordCard-entryPinyin');
                appendTonedPinyin(entryPinyin, entry.Pinyin);
                row.appendChild(entryPinyin);
                if (entry.Traditional !== entry.Simplified) {
                    row.appendChild(el('span', 'studyWordCard-variant', entry.Traditional === word.Text ? entry.Simplified : entry.Traditional));
                }
                row.appendChild(el('span', 'studyWordCard-definitions', entry.Definitions.slice(0, MAX_CARD_DEFINITIONS).join('; ')));
                list.appendChild(row);
            });
            card.appendChild(list);
        } else if (!word.Gloss) {
            card.appendChild(el('div', 'studyWordCard-gloss', globalize.translate('StudyNoDefinition')));
        }

        if (line.Translation || line.Notes) {
            const footer = el('div', 'studyWordCard-line');
            if (line.Translation) footer.appendChild(el('div', 'studyWordCard-translation', line.Translation));
            if (line.Notes) footer.appendChild(el('div', 'studyWordCard-notes', line.Notes));
            card.appendChild(footer);
        }

        this.root.appendChild(card);
        this.card = card;
        this.positionCard();
    }

    /** Places the card above the line, horizontally centered on the selected word but kept on screen. */
    private positionCard(): void {
        const card = this.card;
        const anchor = this.selectedWord >= 0 ? this.wordElement(this.selectedWord) : null;
        if (!card || !anchor) return;

        // Use the line's target position rather than its on-screen rect, which may be mid-transition.
        const margin = 16;
        const wordRect = anchor.getBoundingClientRect();
        const lineBottom = parseFloat(this.lineElem.style.bottom) || 0;
        const left = Math.min(
            Math.max(margin, wordRect.left + (wordRect.width / 2) - (card.offsetWidth / 2)),
            window.innerWidth - card.offsetWidth - margin);
        card.style.left = `${left}px`;
        card.style.bottom = `${lineBottom + this.lineElem.offsetHeight + 8}px`;
    }

    private closeCard(): void {
        this.card?.remove();
        this.card = null;
    }

    private readonly onOsdChanged = (_e: unknown, shown: boolean) => {
        this.osdShown = shown;
        // The OSD slides in; measure once it has its final size.
        setTimeout(this.layout, shown ? 50 : 0);
    };

    /** Positions the burned-in subtitle mask and the line. */
    private readonly layout = () => {
        this.bandTop = null;
        const top = this.options.data.BurnedInSubtitleTop;
        const video = this.options.getVideoElement();
        if (top && video?.videoWidth && video.videoHeight) {
            const rect = video.getBoundingClientRect();
            const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
            const width = video.videoWidth * scale;
            const height = video.videoHeight * scale;
            const contentLeft = rect.left + ((rect.width - width) / 2);
            const contentTop = rect.top + ((rect.height - height) / 2);
            this.bandTop = contentTop + (height * top);
            this.bandHeight = height * (1 - top);
            Object.assign(this.mask.style, {
                left: `${contentLeft}px`,
                width: `${width}px`,
                top: `${this.bandTop}px`,
                height: `${this.bandHeight}px`
            });
        }
        this.mask.classList.toggle('hide', this.bandTop === null || this.mode === 'off');

        const osdHeight = this.osdShown ? this.options.getOsdHeight() : 0;
        let bottom: number;
        if (this.bandTop !== null && !osdHeight) {
            // Center the line in the covered band, where the original subtitles were.
            const lineHeight = this.lineElem.offsetHeight || 0;
            bottom = Math.max(0, window.innerHeight - this.bandTop - this.bandHeight + ((this.bandHeight - lineHeight) / 2));
        } else {
            bottom = osdHeight ? osdHeight + 8 : window.innerHeight * 0.06;
        }
        this.lineElem.style.bottom = `${bottom}px`;
        this.positionCard();
    };
}
