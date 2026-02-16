import escapeHtml from 'escape-html';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import globalize from '../../lib/globalize';
import datetime from '../../scripts/datetime';
import toast from '../../components/toast/toast';
import confirm from '../../components/confirm/confirm';
import loading from '../../components/loading/loading';
import './clips.scss';

const STATUS_MAP = {
    'Pending': { name: 'Pending', css: 'pending', index: 0 },
    'Processing': { name: 'Processing', css: 'processing', index: 1 },
    'Ready': { name: 'Ready', css: 'ready', index: 2 },
    'Failed': { name: 'Failed', css: 'failed', index: 3 }
};

let refreshInterval = null;

function getApiClient() {
    return ServerConnections.currentApiClient();
}

function ticksToDisplay(ticks) {
    const totalSeconds = Math.floor(ticks / 10000000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

function renderClips(view, clips) {
    const listElement = view.querySelector('.clipsList');
    const emptyElement = view.querySelector('.clipsEmpty');

    if (!clips || clips.length === 0) {
        listElement.innerHTML = '';
        emptyElement.classList.remove('hide');
        return;
    }

    emptyElement.classList.add('hide');

    let html = '';
    for (const clip of clips) {
        const statusInfo = STATUS_MAP[clip.Status] || { name: 'Unknown', css: 'pending', index: -1 };
        const statusName = statusInfo.name;
        const statusClass = statusInfo.css;
        const duration = ticksToDisplay(clip.EndTicks - clip.StartTicks);
        const createdDate = datetime.toLocaleDateString(datetime.parseISO8601Date(clip.CreatedAt));

        html += '<div class="clipCard" data-clip-id="' + clip.Id + '">';
        html += '<div class="clipCardInfo">';
        html += '<div class="clipCardTitle">' + escapeHtml(clip.ItemName || 'Clip') + '</div>';
        html += '<div class="clipCardMeta">';
        html += '<span>' + duration + '</span>';
        html += ' &bull; ';
        html += '<span>' + createdDate + '</span>';
        html += ' &bull; ';
        html += '<span class="clipStatusBadge clipStatusBadge-' + statusClass + '">' + statusName + '</span>';
        html += '</div>';
        html += '</div>';
        html += '<div class="clipCardActions">';

        if (clip.Status === 'Ready') {
            html += '<button is="paper-icon-button-light" class="btnPreviewClip" data-clip-id="' + clip.Id + '" title="' + globalize.translate('Preview') + '">';
            html += '<span class="material-icons play_circle" aria-hidden="true"></span>';
            html += '</button>';
            html += '<button is="paper-icon-button-light" class="btnDownloadClip" data-clip-id="' + clip.Id + '" title="' + globalize.translate('Download') + '">';
            html += '<span class="material-icons file_download" aria-hidden="true"></span>';
            html += '</button>';
        }

        html += '<button is="paper-icon-button-light" class="btnDeleteClip" data-clip-id="' + clip.Id + '" title="' + globalize.translate('Delete') + '">';
        html += '<span class="material-icons delete" aria-hidden="true"></span>';
        html += '</button>';

        html += '</div>';
        html += '</div>';
    }

    listElement.innerHTML = html;
}

function loadClips(view) {
    const apiClient = getApiClient();
    const url = apiClient.getUrl('Clips');

    return apiClient.getJSON(url).then(function (clips) {
        renderClips(view, clips);

        // Auto-refresh if any clips are pending/processing
        const hasPending = clips.some(function (c) {
            return c.Status === 'Pending' || c.Status === 'Processing';
        });

        if (hasPending && !refreshInterval) {
            refreshInterval = setInterval(function () {
                loadClips(view);
            }, 5000);
        } else if (!hasPending && refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    });
}

function onDownloadClick(e) {
    const button = e.target.closest('.btnDownloadClip');
    if (!button) return;

    const clipId = button.getAttribute('data-clip-id');
    const apiClient = getApiClient();
    const url = apiClient.getUrl('Clips/' + clipId + '/Download', {
        ApiKey: apiClient.accessToken()
    });

    window.open(url, '_blank');
}

function onPreviewClick(view, e) {
    const button = e.target.closest('.btnPreviewClip');
    if (!button) return;

    const clipId = button.getAttribute('data-clip-id');
    const clipCard = button.closest('.clipCard');
    const existingPreview = view.querySelector('.clipPreview');

    // If a preview is already open for this clip, close it
    if (existingPreview && existingPreview.getAttribute('data-clip-id') === clipId) {
        existingPreview.remove();
        return;
    }

    // Close any other open preview
    if (existingPreview) {
        existingPreview.remove();
    }

    // Create and insert new preview
    const apiClient = getApiClient();
    const streamUrl = apiClient.getUrl('Clips/' + clipId + '/Stream', {
        ApiKey: apiClient.accessToken()
    });

    const previewDiv = document.createElement('div');
    previewDiv.className = 'clipPreview';
    previewDiv.setAttribute('data-clip-id', clipId);

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.src = streamUrl;
    previewDiv.appendChild(video);

    clipCard.insertAdjacentElement('afterend', previewDiv);
}

function onDeleteClick(view, e) {
    const button = e.target.closest('.btnDeleteClip');
    if (!button) return;

    const clipId = button.getAttribute('data-clip-id');

    confirm({
        text: globalize.translate('ConfirmDeleteItem'),
        confirmText: globalize.translate('Delete'),
        primary: 'delete'
    }).then(function () {
        loading.show();
        const apiClient = getApiClient();
        const url = apiClient.getUrl('Clips/' + clipId);

        apiClient.ajax({
            type: 'DELETE',
            url: url
        }).then(function () {
            loading.hide();
            loadClips(view);
        }, function () {
            loading.hide();
        });
    });
}

export default function (view) {
    view.addEventListener('viewshow', function () {
        loading.show();
        loadClips(view).then(function () {
            loading.hide();
        }, function () {
            loading.hide();
        });
    });

    const listElement = view.querySelector('.clipsList');

    listElement.addEventListener('click', function (e) {
        onPreviewClick(view, e);
        onDownloadClick(e);
        onDeleteClick(view, e);
    });

    view.addEventListener('viewhide', function () {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    });

    view.addEventListener('viewdestroy', function () {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    });
}
