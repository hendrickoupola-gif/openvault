/**
 * OpenVault - Agentic Memory Extension for SillyTavern
 *
 * Provides POV-aware memory with witness tracking, relationship dynamics,
 * and emotional continuity for roleplay conversations.
 *
 * All data is stored in chatMetadata - no external services required.
 */

import { eventSource, event_types, saveSettingsDebounced, saveChatConditional, setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { executeSlashCommandsWithOptions } from "../../../slash-commands.js";
import { ConnectionManagerRequestService } from "../../shared.js";

export const extensionName = 'openvault';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Metadata keys
const METADATA_KEY = 'openvault';
const MEMORIES_KEY = 'memories';
const CHARACTERS_KEY = 'character_states';
const RELATIONSHIPS_KEY = 'relationships';
const LAST_PROCESSED_KEY = 'last_processed_message_id';

// Default settings
const defaultSettings = {
    enabled: true,
    automaticMode: false,
    extractionProfile: '',
    tokenBudget: 1000,
    maxMemoriesPerRetrieval: 10,
    debugMode: false,
    // Phase 6 settings
    messagesPerExtraction: 5,      // Number of messages to analyze per extraction
    memoryContextCount: 15,        // Number of recent memories to include in extraction prompt
    smartRetrievalEnabled: false,  // Use LLM to select relevant memories
};

// Operation state machine to prevent concurrent operations
const operationState = {
    generationInProgress: false,
    extractionInProgress: false,
    retrievalInProgress: false,
    pendingInjectionUpdate: false,
};

// Timeout constants for generation flow
const RETRIEVAL_TIMEOUT_MS = 30000; // 30 seconds max for retrieval
const GENERATION_LOCK_TIMEOUT_MS = 120000; // 2 minutes safety timeout

let generationLockTimeout = null;

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} operation - Name for error message
 */
function withTimeout(promise, ms, operation = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
        )
    ]);
}

/**
 * Set generation lock with safety timeout
 */
function setGenerationLock() {
    operationState.generationInProgress = true;

    // Clear any existing safety timeout
    if (generationLockTimeout) {
        clearTimeout(generationLockTimeout);
    }

    // Set safety timeout - if GENERATION_ENDED doesn't fire, clear the lock anyway
    generationLockTimeout = setTimeout(() => {
        if (operationState.generationInProgress) {
            console.warn('OpenVault: Generation lock timeout - clearing stale lock');
            operationState.generationInProgress = false;
        }
    }, GENERATION_LOCK_TIMEOUT_MS);
}

/**
 * Clear generation lock and cancel safety timeout
 */
function clearGenerationLock() {
    operationState.generationInProgress = false;
    if (generationLockTimeout) {
        clearTimeout(generationLockTimeout);
        generationLockTimeout = null;
    }
}

/**
 * Get OpenVault data from chat metadata
 * @returns {Object}
 */
function getOpenVaultData() {
    const context = getContext();
    if (!context.chatMetadata) {
        context.chatMetadata = {};
    }
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = {
            [MEMORIES_KEY]: [],
            [CHARACTERS_KEY]: {},
            [RELATIONSHIPS_KEY]: {},
            [LAST_PROCESSED_KEY]: -1,
        };
    }
    return context.chatMetadata[METADATA_KEY];
}

/**
 * Save OpenVault data to chat metadata
 */
async function saveOpenVaultData() {
    await saveChatConditional();
    log('Data saved to chat metadata');
}

/**
 * Generate a unique ID
 * @returns {string}
 */
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Load extension settings
 */
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // Apply defaults for any missing settings
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }

    // Load HTML template
    const settingsHtml = await $.get(`${extensionFolderPath}/templates/settings_panel.html`);
    $('#extensions_settings2').append(settingsHtml);

    // Bind UI elements
    bindUIElements();

    // Update UI to match current settings
    updateUI();

    console.log('[OpenVault] Settings loaded');
}

/**
 * Bind UI elements to settings
 */
function bindUIElements() {
    const settings = extension_settings[extensionName];

    // Enabled toggle
    $('#openvault_enabled').on('change', function() {
        settings.enabled = $(this).is(':checked');
        saveSettingsDebounced();
        updateEventListeners();
    });

    // Automatic mode toggle
    $('#openvault_automatic').on('change', function() {
        settings.automaticMode = $(this).is(':checked');
        saveSettingsDebounced();
        updateEventListeners();
    });

    // Token budget slider
    $('#openvault_token_budget').on('input', function() {
        settings.tokenBudget = parseInt($(this).val());
        $('#openvault_token_budget_value').text(settings.tokenBudget);
        saveSettingsDebounced();
    });

    // Debug mode toggle
    $('#openvault_debug').on('change', function() {
        settings.debugMode = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // Messages per extraction slider
    $('#openvault_messages_per_extraction').on('input', function() {
        settings.messagesPerExtraction = parseInt($(this).val());
        $('#openvault_messages_per_extraction_value').text(settings.messagesPerExtraction);
        saveSettingsDebounced();
    });

    // Memory context count slider
    $('#openvault_memory_context_count').on('input', function() {
        settings.memoryContextCount = parseInt($(this).val());
        $('#openvault_memory_context_count_value').text(settings.memoryContextCount);
        saveSettingsDebounced();
    });

    // Smart retrieval toggle
    $('#openvault_smart_retrieval').on('change', function() {
        settings.smartRetrievalEnabled = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // Manual action buttons
    $('#openvault_extract_btn').on('click', () => extractMemories());
    $('#openvault_retrieve_btn').on('click', () => retrieveAndInjectContext());
    $('#openvault_extract_all_btn').on('click', () => extractAllMessages());
    $('#openvault_refresh_stats_btn').on('click', () => refreshAllUI());

    // Danger zone buttons
    $('#openvault_delete_chat_btn').on('click', () => deleteCurrentChatData());
    $('#openvault_delete_all_btn').on('click', () => deleteAllData());

    // Profile selector
    $('#openvault_extraction_profile').on('change', function() {
        settings.extractionProfile = $(this).val();
        saveSettingsDebounced();
    });

    // Memory browser pagination
    $('#openvault_prev_page').on('click', () => {
        if (memoryBrowserPage > 0) {
            memoryBrowserPage--;
            renderMemoryBrowser();
        }
    });
    $('#openvault_next_page').on('click', () => {
        memoryBrowserPage++;
        renderMemoryBrowser();
    });

    // Memory browser filters
    $('#openvault_filter_type').on('change', () => {
        memoryBrowserPage = 0;
        renderMemoryBrowser();
    });
    $('#openvault_filter_character').on('change', () => {
        memoryBrowserPage = 0;
        renderMemoryBrowser();
    });
}

/**
 * Update UI to match current settings
 */
function updateUI() {
    const settings = extension_settings[extensionName];

    $('#openvault_enabled').prop('checked', settings.enabled);
    $('#openvault_automatic').prop('checked', settings.automaticMode);
    $('#openvault_token_budget').val(settings.tokenBudget);
    $('#openvault_token_budget_value').text(settings.tokenBudget);
    $('#openvault_debug').prop('checked', settings.debugMode);

    // Phase 6 settings
    $('#openvault_messages_per_extraction').val(settings.messagesPerExtraction);
    $('#openvault_messages_per_extraction_value').text(settings.messagesPerExtraction);
    $('#openvault_memory_context_count').val(settings.memoryContextCount);
    $('#openvault_memory_context_count_value').text(settings.memoryContextCount);
    $('#openvault_smart_retrieval').prop('checked', settings.smartRetrievalEnabled);

    // Populate profile selector
    populateProfileSelector();

    // Refresh all UI components
    refreshAllUI();
}

/**
 * Populate the connection profile selector
 */
function populateProfileSelector() {
    const settings = extension_settings[extensionName];
    const profiles = extension_settings.connectionManager?.profiles || [];
    const $selector = $('#openvault_extraction_profile');

    $selector.empty();
    $selector.append('<option value="">Use current connection</option>');

    for (const profile of profiles) {
        const selected = profile.id === settings.extractionProfile ? 'selected' : '';
        $selector.append(`<option value="${profile.id}" ${selected}>${profile.name}</option>`);
    }
}

/**
 * Refresh statistics display
 */
function refreshStats() {
    const data = getOpenVaultData();

    $('#openvault_stat_events').text(data[MEMORIES_KEY]?.length || 0);
    $('#openvault_stat_characters').text(Object.keys(data[CHARACTERS_KEY] || {}).length);
    $('#openvault_stat_relationships').text(Object.keys(data[RELATIONSHIPS_KEY] || {}).length);

    log(`Stats: ${data[MEMORIES_KEY]?.length || 0} memories, ${Object.keys(data[CHARACTERS_KEY] || {}).length} characters`);
}

// Pagination state for memory browser
let memoryBrowserPage = 0;
const MEMORIES_PER_PAGE = 10;

/**
 * Render the memory browser list
 */
function renderMemoryBrowser() {
    const data = getOpenVaultData();
    const memories = data[MEMORIES_KEY] || [];
    const $list = $('#openvault_memory_list');
    const $pageInfo = $('#openvault_page_info');
    const $prevBtn = $('#openvault_prev_page');
    const $nextBtn = $('#openvault_next_page');

    // Get filter values
    const typeFilter = $('#openvault_filter_type').val();
    const characterFilter = $('#openvault_filter_character').val();

    // Filter memories
    let filteredMemories = memories.filter(m => {
        if (typeFilter && m.event_type !== typeFilter) return false;
        if (characterFilter && !m.characters_involved?.includes(characterFilter)) return false;
        return true;
    });

    // Sort by creation date (newest first)
    filteredMemories.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    // Pagination
    const totalPages = Math.ceil(filteredMemories.length / MEMORIES_PER_PAGE) || 1;
    memoryBrowserPage = Math.min(memoryBrowserPage, totalPages - 1);
    const startIdx = memoryBrowserPage * MEMORIES_PER_PAGE;
    const pageMemories = filteredMemories.slice(startIdx, startIdx + MEMORIES_PER_PAGE);

    // Clear and render
    $list.empty();

    if (pageMemories.length === 0) {
        $list.html('<p class="openvault-placeholder">No memories yet</p>');
    } else {
        for (const memory of pageMemories) {
            const date = memory.created_at ? new Date(memory.created_at).toLocaleDateString() : 'Unknown';
            const typeClass = memory.event_type || 'action';
            const characters = (memory.characters_involved || []).map(c =>
                `<span class="openvault-character-tag">${escapeHtml(c)}</span>`
            ).join('');
            const witnesses = memory.witnesses?.length > 0
                ? `<div class="openvault-memory-witnesses">Witnesses: ${memory.witnesses.join(', ')}</div>`
                : '';

            // Importance stars
            const importance = memory.importance || 3;
            const stars = '★'.repeat(importance) + '☆'.repeat(5 - importance);

            $list.append(`
                <div class="openvault-memory-item ${typeClass}" data-id="${memory.id}">
                    <div class="openvault-memory-header">
                        <span class="openvault-memory-type">${escapeHtml(memory.event_type || 'event')}</span>
                        <span class="openvault-memory-importance" title="Importance: ${importance}/5">${stars}</span>
                        <span class="openvault-memory-date">${date}</span>
                    </div>
                    <div class="openvault-memory-summary">${escapeHtml(memory.summary || 'No summary')}</div>
                    <div class="openvault-memory-characters">${characters}</div>
                    ${witnesses}
                    <div class="openvault-memory-actions">
                        <button class="menu_button openvault-delete-memory" data-id="${memory.id}">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `);
        }

        // Bind delete buttons
        $list.find('.openvault-delete-memory').on('click', async function() {
            const id = $(this).data('id');
            await deleteMemory(id);
        });
    }

    // Update pagination
    $pageInfo.text(`Page ${memoryBrowserPage + 1} of ${totalPages}`);
    $prevBtn.prop('disabled', memoryBrowserPage === 0);
    $nextBtn.prop('disabled', memoryBrowserPage >= totalPages - 1);

    // Populate character filter dropdown
    populateCharacterFilter();
}

/**
 * Delete a memory by ID
 */
async function deleteMemory(id) {
    const data = getOpenVaultData();
    const idx = data[MEMORIES_KEY]?.findIndex(m => m.id === id);
    if (idx !== -1) {
        data[MEMORIES_KEY].splice(idx, 1);
        await saveChatConditional();
        refreshAllUI();
        toastr.success('Memory deleted', 'OpenVault');
    }
}

/**
 * Populate the character filter dropdown
 */
function populateCharacterFilter() {
    const data = getOpenVaultData();
    const memories = data[MEMORIES_KEY] || [];
    const characters = new Set();

    for (const memory of memories) {
        for (const char of (memory.characters_involved || [])) {
            characters.add(char);
        }
    }

    const $filter = $('#openvault_filter_character');
    const currentValue = $filter.val();
    $filter.find('option:not(:first)').remove();

    for (const char of Array.from(characters).sort()) {
        $filter.append(`<option value="${escapeHtml(char)}">${escapeHtml(char)}</option>`);
    }

    // Restore selection if still valid
    if (currentValue && characters.has(currentValue)) {
        $filter.val(currentValue);
    }
}

/**
 * Render character states
 */
function renderCharacterStates() {
    const data = getOpenVaultData();
    const characters = data[CHARACTERS_KEY] || {};
    const $container = $('#openvault_character_states');

    $container.empty();

    const charNames = Object.keys(characters);
    if (charNames.length === 0) {
        $container.html('<p class="openvault-placeholder">No character data yet</p>');
        return;
    }

    for (const name of charNames.sort()) {
        const char = characters[name];
        const emotion = char.current_emotion || 'neutral';
        const intensity = char.emotion_intensity || 5;
        const knownCount = char.known_events?.length || 0;

        $container.append(`
            <div class="openvault-character-item">
                <div class="openvault-character-name">${escapeHtml(name)}</div>
                <div class="openvault-emotion">
                    <span class="openvault-emotion-label">${escapeHtml(emotion)}</span>
                    <div class="openvault-emotion-bar">
                        <div class="openvault-emotion-fill" style="width: ${intensity * 10}%"></div>
                    </div>
                </div>
                <div class="openvault-memory-witnesses">Known events: ${knownCount}</div>
            </div>
        `);
    }
}

/**
 * Render relationships
 */
function renderRelationships() {
    const data = getOpenVaultData();
    const relationships = data[RELATIONSHIPS_KEY] || {};
    const $container = $('#openvault_relationships');

    $container.empty();

    const relKeys = Object.keys(relationships);
    if (relKeys.length === 0) {
        $container.html('<p class="openvault-placeholder">No relationship data yet</p>');
        return;
    }

    for (const key of relKeys.sort()) {
        const rel = relationships[key];
        const trust = rel.trust_level || 5;
        const tension = rel.tension_level || 0;
        const type = rel.relationship_type || 'acquaintance';

        $container.append(`
            <div class="openvault-relationship-item">
                <div class="openvault-relationship-pair">${escapeHtml(rel.character_a || '?')} ↔ ${escapeHtml(rel.character_b || '?')}</div>
                <div class="openvault-relationship-type">${escapeHtml(type)}</div>
                <div class="openvault-relationship-bars">
                    <div class="openvault-bar-row">
                        <span class="openvault-bar-label">Trust</span>
                        <div class="openvault-bar-container">
                            <div class="openvault-bar-fill trust" style="width: ${trust * 10}%"></div>
                        </div>
                    </div>
                    <div class="openvault-bar-row">
                        <span class="openvault-bar-label">Tension</span>
                        <div class="openvault-bar-container">
                            <div class="openvault-bar-fill tension" style="width: ${tension * 10}%"></div>
                        </div>
                    </div>
                </div>
            </div>
        `);
    }
}

/**
 * Refresh all UI components
 */
function refreshAllUI() {
    refreshStats();
    renderMemoryBrowser();
    renderCharacterStates();
    renderRelationships();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Update event listeners based on settings
 */
function updateEventListeners() {
    const settings = extension_settings[extensionName];

    // Remove existing listeners first
    eventSource.removeListener(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);

    // Reset operation state only if no generation in progress
    // This prevents race conditions when user toggles settings mid-generation
    if (!operationState.generationInProgress) {
        operationState.extractionInProgress = false;
        operationState.retrievalInProgress = false;
        operationState.pendingInjectionUpdate = false;
    } else {
        log('Warning: Settings changed during generation, keeping locks');
    }

    // Add listeners if enabled and automatic mode is on
    if (settings.enabled && settings.automaticMode) {
        // GENERATION_AFTER_COMMANDS: Fires after slash commands but BEFORE generation
        // Use makeFirst to ensure we run before other handlers and block generation
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
        eventSource.makeFirst(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
        // GENERATION_ENDED: Clear generation lock, process pending updates
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
        // MESSAGE_RECEIVED: Extract after AI responds (LLM call happens here, safely after generation)
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        log('Automatic mode enabled - listening for generation and message events');
        // Initialize the injection (async, handle errors)
        updateInjection().catch(err => console.error('OpenVault: Init injection error:', err));
    } else {
        // Clear injection when disabled/manual
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        log('Manual mode - event listeners removed, injection cleared');
    }
}

/**
 * Handle generation ended event
 * Clears the generation lock and processes any pending updates
 */
function onGenerationEnded() {
    clearGenerationLock(); // Use helper that also clears safety timeout
    log('Generation ended, clearing lock');

    // If there was a pending injection update, do it now
    if (operationState.pendingInjectionUpdate) {
        operationState.pendingInjectionUpdate = false;
        log('Processing pending injection update');
        updateInjection().catch(err => console.error('OpenVault: Pending injection error:', err));
    }
}

/**
 * Handle chat changed event
 */
async function onChatChanged() {
    const settings = extension_settings[extensionName];
    if (!settings.enabled || !settings.automaticMode) return;

    log('Chat changed, scheduling injection update');

    // If generation is happening, defer the update
    if (operationState.generationInProgress) {
        operationState.pendingInjectionUpdate = true;
        log('Generation in progress, deferring chat change update');
        return;
    }

    // Small delay to ensure chat metadata is loaded
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check again after delay - generation might have started
    if (operationState.generationInProgress) {
        operationState.pendingInjectionUpdate = true;
        log('Generation started during delay, deferring update');
        return;
    }

    try {
        await updateInjection();
    } catch (error) {
        console.error('OpenVault: Chat change injection error:', error);
    }
}

/**
 * Handle message received event (automatic mode)
 * Extracts memories AFTER AI responds - this avoids conflicts with generation
 * Excludes the last user+assistant pair to avoid extracting swiped messages
 */
async function onMessageReceived(messageId) {
    const settings = extension_settings[extensionName];
    if (!settings.enabled || !settings.automaticMode) return;

    // Don't extract during generation or if already extracting
    if (operationState.generationInProgress) {
        log('Skipping extraction - generation still in progress');
        return;
    }
    if (operationState.extractionInProgress) {
        log('Skipping extraction - extraction already in progress');
        return;
    }

    const context = getContext();
    const chat = context.chat || [];
    const message = chat[messageId];

    // Only extract after AI messages (not user messages)
    // This ensures extraction happens after generation completes, avoiding ECONNRESET
    if (!message || message.is_user || message.is_system) {
        log(`Message ${messageId} is user/system message, skipping extraction`);
        return;
    }

    log(`AI message received: ${messageId}, checking if extraction needed`);

    // Check if we should extract (every N messages)
    const data = getOpenVaultData();
    const lastProcessedId = data[LAST_PROCESSED_KEY] || -1;
    const messageCount = settings.messagesPerExtraction || 5;

    // Get extractable messages: exclude the last 2 messages (most recent user + assistant)
    // This prevents extracting messages that might be swiped
    const nonSystemMessages = chat
        .map((m, idx) => ({ ...m, idx }))
        .filter(m => !m.is_system);

    // Exclude last 2 messages (the user message that triggered this + the AI response)
    const safeMessages = nonSystemMessages.slice(0, -2);

    // Count unprocessed safe messages
    const unprocessedMessages = safeMessages.filter(m => m.idx > lastProcessedId);

    // Extract if we have enough unprocessed messages
    if (unprocessedMessages.length >= messageCount) {
        log(`Automatic extraction: ${unprocessedMessages.length} unprocessed messages (threshold: ${messageCount}), excluding last 2`);

        operationState.extractionInProgress = true;
        try {
            // Extract only the safe message IDs (excluding last user+assistant pair)
            const safeMessageIds = unprocessedMessages.slice(-messageCount).map(m => m.idx);
            await extractMemories(safeMessageIds);

            // Update injection for next generation (if not currently generating)
            if (!operationState.generationInProgress) {
                await updateInjection();
            } else {
                operationState.pendingInjectionUpdate = true;
            }
        } catch (error) {
            console.error('[OpenVault] Automatic extraction error:', error);
        } finally {
            operationState.extractionInProgress = false;
        }
    } else {
        log(`Skipping extraction: only ${unprocessedMessages.length} safe unprocessed messages (threshold: ${messageCount})`);
    }
}

/**
 * Handle before-generation event (automatic mode)
 * Uses GENERATION_AFTER_COMMANDS which fires AFTER slash commands but BEFORE generation
 * This is the correct hook point - same pattern Quick Replies uses
 * ST awaits async handlers, so retrieval completes before generation proceeds
 */
async function onBeforeGeneration(generationType, options = {}, isDryRun = false) {
    const startTime = Date.now();
    log(`>>> BEFORE_GENERATION START [type=${generationType}, dryRun=${isDryRun}]`);

    const settings = extension_settings[extensionName];
    if (!settings.enabled || !settings.automaticMode) {
        log(`>>> BEFORE_GENERATION END (disabled) [${Date.now() - startTime}ms]`);
        return;
    }

    // Skip dry runs (just calculating token counts, not actual generation)
    if (isDryRun) {
        log(`>>> BEFORE_GENERATION END (dryRun) [${Date.now() - startTime}ms]`);
        return;
    }

    // Only proceed for normal generation (user sent a message)
    // Skip swipes and regenerates - they should use existing injection
    if (generationType === 'swipe' || generationType === 'regenerate') {
        log(`>>> BEFORE_GENERATION END (${generationType}, using existing) [${Date.now() - startTime}ms]`);
        return;
    }

    // Set generation lock FIRST to prevent race conditions
    setGenerationLock();

    // Check if retrieval is already in progress
    if (operationState.retrievalInProgress) {
        log(`>>> BEFORE_GENERATION END (retrieval already in progress) [${Date.now() - startTime}ms]`);
        // Don't clear generation lock - let it time out or be cleared by GENERATION_ENDED
        return;
    }

    operationState.retrievalInProgress = true;

    // Capture the pending user message from textarea
    // At GENERATION_AFTER_COMMANDS, the user's message is still in textarea, not yet in chat
    const pendingUserMessage = String($('#send_textarea').val()).trim();
    if (pendingUserMessage) {
        log(`>>> Pending user message: "${pendingUserMessage.substring(0, 50)}..."`);
    }

    try {
        log('>>> Starting retrieval...');
        // Use timeout to prevent hanging forever
        // Pass pending user message so retrieval AI can see what user just typed
        await withTimeout(
            updateInjection(pendingUserMessage),
            RETRIEVAL_TIMEOUT_MS,
            'Memory retrieval'
        );
        log(`>>> BEFORE_GENERATION END (success) [${Date.now() - startTime}ms]`);
    } catch (error) {
        if (error.message.includes('timed out')) {
            console.warn('OpenVault: Retrieval timed out, proceeding with existing context');
            log(`>>> BEFORE_GENERATION END (timeout) [${Date.now() - startTime}ms]`);
        } else {
            console.error('OpenVault: Error during pre-generation retrieval:', error);
            log(`>>> BEFORE_GENERATION END (error) [${Date.now() - startTime}ms]`);
        }
        // Continue with whatever injection was already set
    } finally {
        operationState.retrievalInProgress = false;
        // Note: generationInProgress stays true until GENERATION_ENDED
    }
}

/**
 * Extract memories from messages using LLM
 * @param {number[]} messageIds - Optional specific message IDs to extract
 */
async function extractMemories(messageIds = null) {
    const settings = extension_settings[extensionName];
    if (!settings.enabled) {
        toastr.warning('OpenVault is disabled', 'OpenVault');
        return;
    }

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        toastr.warning('No chat messages to extract', 'OpenVault');
        return;
    }

    const data = getOpenVaultData();

    // Get messages to extract
    let messagesToExtract = [];
    if (messageIds && messageIds.length > 0) {
        messagesToExtract = messageIds
            .map(id => ({ id, ...chat[id] }))
            .filter(m => m && !m.is_system);
    } else {
        // Extract last few unprocessed messages (configurable count)
        const lastProcessedId = data[LAST_PROCESSED_KEY] || -1;
        const messageCount = settings.messagesPerExtraction || 5;
        messagesToExtract = chat
            .map((m, idx) => ({ id: idx, ...m }))
            .filter(m => !m.is_system && m.id > lastProcessedId)
            .slice(-messageCount);
    }

    if (messagesToExtract.length === 0) {
        toastr.info('No new messages to extract', 'OpenVault');
        return;
    }

    log(`Extracting ${messagesToExtract.length} messages`);
    setStatus('extracting');

    try {
        const characterName = context.name2;
        const userName = context.name1;

        // Build extraction prompt
        const messagesText = messagesToExtract.map(m => {
            const speaker = m.is_user ? userName : (m.name || characterName);
            return `[${speaker}]: ${m.mes}`;
        }).join('\n\n');

        // Get existing memories for context (to avoid duplicates and maintain consistency)
        const memoryContextCount = settings.memoryContextCount || 0;
        const existingMemories = getRecentMemoriesForContext(memoryContextCount);

        const extractionPrompt = buildExtractionPrompt(messagesText, characterName, userName, existingMemories);

        // Call LLM for extraction
        const extractedJson = await callLLMForExtraction(extractionPrompt);

        if (!extractedJson) {
            throw new Error('No extraction result from LLM');
        }

        // Parse and store extracted events
        const events = parseExtractionResult(extractedJson, messagesToExtract, characterName, userName);

        if (events.length > 0) {
            // Add events to storage
            data[MEMORIES_KEY] = data[MEMORIES_KEY] || [];
            data[MEMORIES_KEY].push(...events);

            // Update character states and relationships
            updateCharacterStatesFromEvents(events, data);
            updateRelationshipsFromEvents(events, data);

            // Update last processed message ID
            const maxId = Math.max(...messagesToExtract.map(m => m.id));
            data[LAST_PROCESSED_KEY] = Math.max(data[LAST_PROCESSED_KEY] || -1, maxId);

            await saveOpenVaultData();

            log(`Extracted ${events.length} events`);
            toastr.success(`Extracted ${events.length} memory events`, 'OpenVault');
        } else {
            toastr.info('No significant events found in messages', 'OpenVault');
        }

        setStatus('ready');
        refreshAllUI();

        return { events_created: events.length, messages_processed: messagesToExtract.length };
    } catch (error) {
        console.error('[OpenVault] Extraction error:', error);
        toastr.error(`Extraction failed: ${error.message}`, 'OpenVault');
        setStatus('error');
        throw error;
    }
}

/**
 * Get recent memories for context during extraction
 * @param {number} count - Number of recent memories to retrieve
 * @returns {Object[]} - Array of recent memory objects
 */
function getRecentMemoriesForContext(count) {
    if (count <= 0) return [];

    const data = getOpenVaultData();
    const memories = data[MEMORIES_KEY] || [];

    // Sort by sequence/creation time (newest first) and take the requested count
    const sorted = [...memories].sort((a, b) => {
        const seqA = a.sequence ?? a.created_at ?? 0;
        const seqB = b.sequence ?? b.created_at ?? 0;
        return seqB - seqA;
    });

    return sorted.slice(0, count);
}

/**
 * Build the extraction prompt
 * @param {string} messagesText - Formatted messages to analyze
 * @param {string} characterName - Main character name
 * @param {string} userName - User character name
 * @param {Object[]} existingMemories - Recent memories for context (optional)
 */
function buildExtractionPrompt(messagesText, characterName, userName, existingMemories = []) {
    // Build memory context section if we have existing memories
    let memoryContextSection = '';
    if (existingMemories && existingMemories.length > 0) {
        const memorySummaries = existingMemories
            .sort((a, b) => (a.sequence ?? a.created_at ?? 0) - (b.sequence ?? b.created_at ?? 0))
            .map((m, i) => `${i + 1}. [${m.event_type || 'event'}] ${m.summary}`)
            .join('\n');

        memoryContextSection = `
## Previously Established Memories
The following events have already been recorded. Use this context to:
- Avoid duplicating already-recorded events
- Maintain consistency with established facts
- Build upon existing character developments

${memorySummaries}

`;
    }

    return `You are analyzing roleplay messages to extract structured memory events.

## Characters
- Main character: ${characterName}
- User's character: ${userName}
${memoryContextSection}
## Messages to analyze:
${messagesText}

## Task
Extract NEW significant events from these messages. For each event, identify:
1. **event_type**: One of: "action", "revelation", "emotion_shift", "relationship_change"
2. **importance**: 1-5 scale (1=minor detail, 2=notable, 3=significant, 4=major event, 5=critical/story-changing)
3. **summary**: Brief description of what happened (1-2 sentences)
4. **characters_involved**: List of character names directly involved
5. **witnesses**: List of character names who observed this (important for POV filtering)
6. **location**: Where this happened (if mentioned, otherwise "unknown")
7. **is_secret**: Whether this information should only be known by witnesses
8. **emotional_impact**: Object mapping character names to emotional changes (e.g., {"${characterName}": "growing trust", "${userName}": "surprised"})
9. **relationship_impact**: Object describing relationship changes (e.g., {"${characterName}->${userName}": "trust increased"})

Only extract events that are significant for character memory and story continuity. Skip mundane exchanges.
${existingMemories.length > 0 ? 'Do NOT duplicate events from the "Previously Established Memories" section.' : ''}

Respond with a JSON array of events:
\`\`\`json
[
  {
    "event_type": "...",
    "importance": 3,
    "summary": "...",
    "characters_involved": [...],
    "witnesses": [...],
    "location": "...",
    "is_secret": false,
    "emotional_impact": {...},
    "relationship_impact": {...}
  }
]
\`\`\`

If no significant events, respond with an empty array: []`;
}

/**
 * Call LLM for extraction using ConnectionManagerRequestService
 */
async function callLLMForExtraction(prompt) {
    const settings = extension_settings[extensionName];

    // Get profile ID - use extraction profile or fall back to first available
    let profileId = settings.extractionProfile;

    // If no profile specified, try to use the connection manager's first profile
    if (!profileId) {
        const profiles = extension_settings?.connectionManager?.profiles || [];
        if (profiles.length > 0) {
            profileId = profiles[0].id;
            log(`No extraction profile set, using first available: ${profiles[0].name}`);
        }
    }

    if (!profileId || !ConnectionManagerRequestService) {
        log('No connection profile available for extraction');
        toastr.warning('Please select an extraction profile in OpenVault settings', 'OpenVault');
        return null;
    }

    try {
        log(`Using ConnectionManagerRequestService with profile: ${profileId}`);

        // Build messages array
        const messages = [
            {
                role: 'system',
                content: 'You are a helpful assistant that extracts structured data from roleplay conversations. Always respond with valid JSON only, no markdown formatting.'
            },
            { role: 'user', content: prompt }
        ];

        // Send request via ConnectionManagerRequestService
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            2000, // max tokens
            {
                includePreset: true,
                includeInstruct: true,
                stream: false
            },
            {} // override payload
        );

        // Extract content from response
        const content = result?.content || result || '';

        // Parse reasoning if present (some models return thinking tags)
        const context = getContext();
        if (context.parseReasoningFromString) {
            const parsed = context.parseReasoningFromString(content);
            return parsed ? parsed.content : content;
        }

        return content;
    } catch (error) {
        log(`LLM call error: ${error.message}`);
        toastr.error(`Extraction failed: ${error.message}`, 'OpenVault');
        return null;
    }
}

/**
 * Parse extraction result from LLM
 */
function parseExtractionResult(jsonString, messages, characterName, userName) {
    try {
        // Extract JSON from response (handle markdown code blocks)
        let cleaned = jsonString;
        const jsonMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            cleaned = jsonMatch[1];
        }

        const parsed = JSON.parse(cleaned.trim());
        const events = Array.isArray(parsed) ? parsed : [parsed];

        // Get message IDs for sequence ordering
        const messageIds = messages.map(m => m.id);
        const minMessageId = Math.min(...messageIds);

        // Enrich events with metadata
        return events.map((event, index) => ({
            id: generateId(),
            ...event,
            message_ids: messageIds,
            // Sequence is based on the earliest message ID, with sub-index for multiple events from same batch
            sequence: minMessageId * 1000 + index,
            created_at: Date.now(),
            characters_involved: event.characters_involved || [],
            witnesses: event.witnesses || event.characters_involved || [],
            location: event.location || 'unknown',
            is_secret: event.is_secret || false,
            importance: Math.min(5, Math.max(1, event.importance || 3)), // Clamp to 1-5, default 3
            emotional_impact: event.emotional_impact || {},
            relationship_impact: event.relationship_impact || {},
        }));
    } catch (error) {
        log(`Failed to parse extraction result: ${error.message}`);
        return [];
    }
}

/**
 * Update character states based on extracted events
 */
function updateCharacterStatesFromEvents(events, data) {
    data[CHARACTERS_KEY] = data[CHARACTERS_KEY] || {};

    for (const event of events) {
        // Update emotional impact
        if (event.emotional_impact) {
            for (const [charName, emotion] of Object.entries(event.emotional_impact)) {
                if (!data[CHARACTERS_KEY][charName]) {
                    data[CHARACTERS_KEY][charName] = {
                        name: charName,
                        current_emotion: 'neutral',
                        emotion_intensity: 5,
                        known_events: [],
                    };
                }

                // Update emotion
                data[CHARACTERS_KEY][charName].current_emotion = emotion;
                data[CHARACTERS_KEY][charName].last_updated = Date.now();
            }
        }

        // Add event to witnesses' knowledge
        for (const witness of (event.witnesses || [])) {
            if (!data[CHARACTERS_KEY][witness]) {
                data[CHARACTERS_KEY][witness] = {
                    name: witness,
                    current_emotion: 'neutral',
                    emotion_intensity: 5,
                    known_events: [],
                };
            }
            if (!data[CHARACTERS_KEY][witness].known_events.includes(event.id)) {
                data[CHARACTERS_KEY][witness].known_events.push(event.id);
            }
        }
    }
}

/**
 * Update relationships based on extracted events
 */
function updateRelationshipsFromEvents(events, data) {
    data[RELATIONSHIPS_KEY] = data[RELATIONSHIPS_KEY] || {};

    for (const event of events) {
        if (event.relationship_impact) {
            for (const [relationKey, impact] of Object.entries(event.relationship_impact)) {
                // Parse relationship key (e.g., "Alice->Bob")
                const match = relationKey.match(/^(.+?)\s*->\s*(.+)$/);
                if (!match) continue;

                const [, charA, charB] = match;
                const key = `${charA}<->${charB}`;

                if (!data[RELATIONSHIPS_KEY][key]) {
                    data[RELATIONSHIPS_KEY][key] = {
                        character_a: charA,
                        character_b: charB,
                        trust_level: 5,
                        tension_level: 0,
                        relationship_type: 'acquaintance',
                        history: [],
                    };
                }

                // Update based on impact description
                const impactLower = impact.toLowerCase();
                if (impactLower.includes('trust') && impactLower.includes('increas')) {
                    data[RELATIONSHIPS_KEY][key].trust_level = Math.min(10, data[RELATIONSHIPS_KEY][key].trust_level + 1);
                } else if (impactLower.includes('trust') && impactLower.includes('decreas')) {
                    data[RELATIONSHIPS_KEY][key].trust_level = Math.max(0, data[RELATIONSHIPS_KEY][key].trust_level - 1);
                }

                if (impactLower.includes('tension') && impactLower.includes('increas')) {
                    data[RELATIONSHIPS_KEY][key].tension_level = Math.min(10, data[RELATIONSHIPS_KEY][key].tension_level + 1);
                } else if (impactLower.includes('tension') && impactLower.includes('decreas')) {
                    data[RELATIONSHIPS_KEY][key].tension_level = Math.max(0, data[RELATIONSHIPS_KEY][key].tension_level - 1);
                }

                // Add to history
                data[RELATIONSHIPS_KEY][key].history.push({
                    event_id: event.id,
                    impact: impact,
                    timestamp: Date.now(),
                });
            }
        }
    }
}

/**
 * Extract memories from all messages EXCEPT the last N in current chat
 * N is determined by the messagesPerExtraction setting
 * This backfills chat history, leaving recent messages for automatic extraction
 */
async function extractAllMessages() {
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        toastr.warning('No chat messages to extract', 'OpenVault');
        return;
    }

    const settings = extension_settings[extensionName];
    const messageCount = settings.messagesPerExtraction || 5;

    // Get all non-system messages EXCEPT the last N
    const allNonSystemIds = chat
        .map((m, idx) => idx)
        .filter(idx => !chat[idx].is_system);

    // Exclude the last N messages (they'll be handled by regular/automatic extraction)
    const messagesToExtract = allNonSystemIds.slice(0, -messageCount);

    if (messagesToExtract.length === 0) {
        toastr.warning('No messages to extract (all messages are within the last N)', 'OpenVault');
        return;
    }

    toastr.info(`Extracting ${messagesToExtract.length} messages (excluding last ${messageCount})...`, 'OpenVault');

    // Reset last processed to start fresh
    const data = getOpenVaultData();
    data[LAST_PROCESSED_KEY] = -1;

    // Process in batches
    const batchSize = messageCount;
    let totalEvents = 0;

    for (let i = 0; i < messagesToExtract.length; i += batchSize) {
        const batch = messagesToExtract.slice(i, i + batchSize);
        try {
            const result = await extractMemories(batch);
            totalEvents += result?.events_created || 0;

            // Small delay between batches to avoid rate limiting
            if (i + batchSize < messagesToExtract.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error('[OpenVault] Batch extraction error:', error);
        }
    }

    toastr.success(`Extracted ${totalEvents} events from ${messagesToExtract.length} messages`, 'OpenVault');
    refreshAllUI();
}

/**
 * Retrieve relevant context and inject into prompt
 */
async function retrieveAndInjectContext() {
    const settings = extension_settings[extensionName];
    if (!settings.enabled) {
        log('OpenVault disabled, skipping retrieval');
        return null;
    }

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        log('No chat to retrieve context for');
        return null;
    }

    const data = getOpenVaultData();
    const memories = data[MEMORIES_KEY] || [];

    if (memories.length === 0) {
        log('No memories stored yet');
        return null;
    }

    setStatus('retrieving');

    try {
        const userName = context.name1;
        const activeCharacters = getActiveCharacters();

        // Get POV context (different behavior for group chat vs narrator mode)
        const { povCharacters, isGroupChat } = getPOVContext();

        // Collect known events from all POV characters
        const knownEventIds = new Set();
        for (const charName of povCharacters) {
            const charState = data[CHARACTERS_KEY]?.[charName];
            if (charState?.known_events) {
                for (const eventId of charState.known_events) {
                    knownEventIds.add(eventId);
                }
            }
        }

        // Filter memories by POV - memories that ANY of the POV characters know
        const povCharactersLower = povCharacters.map(c => c.toLowerCase());
        const accessibleMemories = memories.filter(m => {
            // Any POV character was a witness (case-insensitive)
            if (m.witnesses?.some(w => povCharactersLower.includes(w.toLowerCase()))) return true;
            // Non-secret events that any POV character is involved in
            if (!m.is_secret && m.characters_involved?.some(c => povCharactersLower.includes(c.toLowerCase()))) return true;
            // Explicitly in any POV character's known events
            if (knownEventIds.has(m.id)) return true;
            return false;
        });

        log(`POV filter: mode=${isGroupChat ? 'group' : 'narrator'}, characters=[${povCharacters.join(', ')}], total=${memories.length}, accessible=${accessibleMemories.length}`);

        // If POV filtering is too strict, fall back to all memories with a warning
        let memoriesToUse = accessibleMemories;
        if (accessibleMemories.length === 0 && memories.length > 0) {
            log('POV filter returned 0 results, using all memories as fallback');
            memoriesToUse = memories;
        }

        if (memoriesToUse.length === 0) {
            log('No memories available');
            setStatus('ready');
            return null;
        }

        // Use first POV character for formatting (or main character for narrator mode)
        const primaryCharacter = isGroupChat ? povCharacters[0] : context.name2;

        // Get recent context for relevance matching
        const recentMessages = chat
            .filter(m => !m.is_system)
            .slice(-5)
            .map(m => m.mes)
            .join('\n');

        // Build retrieval prompt to select relevant memories
        const relevantMemories = await selectRelevantMemories(
            memoriesToUse,
            recentMessages,
            primaryCharacter,
            activeCharacters,
            settings.maxMemoriesPerRetrieval
        );

        if (!relevantMemories || relevantMemories.length === 0) {
            log('No relevant memories found');
            setStatus('ready');
            return null;
        }

        // Get relationship context for the primary character
        const relationshipContext = getRelationshipContext(data, primaryCharacter, activeCharacters);

        // Get emotional state of primary character
        const primaryCharState = data[CHARACTERS_KEY]?.[primaryCharacter];
        const emotionalState = primaryCharState?.current_emotion || 'neutral';

        // Format header based on mode
        const headerName = isGroupChat ? primaryCharacter : 'Scene';

        // Format and inject context
        const formattedContext = formatContextForInjection(
            relevantMemories,
            relationshipContext,
            emotionalState,
            headerName,
            settings.tokenBudget
        );

        if (formattedContext) {
            injectContext(formattedContext);
            log(`Injected ${relevantMemories.length} memories into context`);
            toastr.success(`Retrieved ${relevantMemories.length} relevant memories`, 'OpenVault');
        }

        setStatus('ready');
        return { memories: relevantMemories, context: formattedContext };
    } catch (error) {
        console.error('[OpenVault] Retrieval error:', error);
        setStatus('error');
        return null;
    }
}

/**
 * Select relevant memories using simple scoring (fast mode)
 */
function selectRelevantMemoriesSimple(memories, recentContext, characterName, activeCharacters, limit) {
    // Simple relevance scoring based on:
    // 1. Importance (highest weight)
    // 2. Recency
    // 3. Character involvement
    // 4. Keyword matching

    const scored = memories.map(memory => {
        let score = 0;

        // Importance bonus (major factor: 0-20 points based on 1-5 scale)
        const importance = memory.importance || 3;
        score += importance * 4; // 4, 8, 12, 16, 20 points

        // Recency bonus (newer = higher)
        const age = Date.now() - memory.created_at;
        const ageHours = age / (1000 * 60 * 60);
        score += Math.max(0, 10 - ageHours); // Up to 10 points for recent

        // Character involvement bonus
        for (const char of activeCharacters) {
            if (memory.characters_involved?.includes(char)) score += 5;
            if (memory.witnesses?.includes(char)) score += 3;
        }

        // Keyword matching (simple)
        const summaryLower = memory.summary?.toLowerCase() || '';
        const contextLower = recentContext.toLowerCase();
        const contextWords = contextLower.split(/\s+/).filter(w => w.length > 3);

        for (const word of contextWords) {
            if (summaryLower.includes(word)) score += 1;
        }

        // Event type bonus
        if (memory.event_type === 'revelation') score += 3;
        if (memory.event_type === 'relationship_change') score += 2;

        return { memory, score };
    });

    // Sort by score and take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.memory);
}

/**
 * Select relevant memories using LLM (smart mode)
 * @param {Object[]} memories - Available memories to select from
 * @param {string} recentContext - Recent chat context
 * @param {string} characterName - POV character name
 * @param {number} limit - Maximum memories to select
 * @returns {Promise<Object[]>} - Selected memories
 */
async function selectRelevantMemoriesSmart(memories, recentContext, characterName, limit) {
    if (memories.length === 0) return [];
    if (memories.length <= limit) return memories; // No need to select if we have few enough

    log(`Smart retrieval: analyzing ${memories.length} memories to select ${limit} most relevant`);

    // Build numbered list of memories with importance
    const numberedList = memories.map((m, i) => {
        const typeTag = `[${m.event_type || 'event'}]`;
        const importance = m.importance || 3;
        const importanceTag = `[★${'★'.repeat(importance - 1)}]`; // Show 1-5 stars
        const secretTag = m.is_secret ? '[Secret] ' : '';
        return `${i + 1}. ${typeTag} ${importanceTag} ${secretTag}${m.summary}`;
    }).join('\n');

    const prompt = `You are a narrative memory analyzer. Given the current roleplay scene and a list of available memories, select which memories are most relevant for the AI to reference in its response.

CURRENT SCENE:
${recentContext}

AVAILABLE MEMORIES (numbered):
${numberedList}

[Task]: Select up to ${limit} memories that would be most useful for ${characterName} to know for the current scene. Consider:
- Importance level (★ to ★★★★★) - higher importance events are more critical to the story
- Direct relevance to current conversation topics
- Character relationships being discussed
- Background context that explains current situations
- Emotional continuity
- Secrets the character knows

[Return]: JSON object with selected memory numbers (1-indexed) and brief reasoning:
{"selected": [1, 4, 7], "reasoning": "Brief explanation of why these memories are relevant"}

Only return valid JSON, no markdown formatting.`;

    try {
        const response = await callLLMForExtraction(prompt);

        if (!response) {
            log('Smart retrieval: No response from LLM, falling back to simple mode');
            return selectRelevantMemoriesSimple(memories, recentContext, characterName, [], limit);
        }

        // Parse the response
        let parsed;
        try {
            // Handle potential markdown code blocks
            let cleaned = response;
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                cleaned = jsonMatch[1];
            }
            parsed = JSON.parse(cleaned.trim());
        } catch (parseError) {
            log(`Smart retrieval: Failed to parse LLM response, falling back to simple mode. Error: ${parseError.message}`);
            return selectRelevantMemoriesSimple(memories, recentContext, characterName, [], limit);
        }

        // Extract selected indices
        const selectedIndices = parsed.selected || [];
        if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
            log('Smart retrieval: No memories selected by LLM, falling back to simple mode');
            return selectRelevantMemoriesSimple(memories, recentContext, characterName, [], limit);
        }

        // Convert 1-indexed to 0-indexed and filter valid indices
        const selectedMemories = selectedIndices
            .map(i => memories[i - 1]) // Convert to 0-indexed
            .filter(m => m !== undefined);

        if (selectedMemories.length === 0) {
            log('Smart retrieval: Invalid indices from LLM, falling back to simple mode');
            return selectRelevantMemoriesSimple(memories, recentContext, characterName, [], limit);
        }

        log(`Smart retrieval: LLM selected ${selectedMemories.length} memories. Reasoning: ${parsed.reasoning || 'none provided'}`);
        return selectedMemories;
    } catch (error) {
        log(`Smart retrieval error: ${error.message}, falling back to simple mode`);
        return selectRelevantMemoriesSimple(memories, recentContext, characterName, [], limit);
    }
}

/**
 * Select relevant memories using LLM or simple matching (dispatcher)
 * Uses smart retrieval if enabled in settings
 */
async function selectRelevantMemories(memories, recentContext, characterName, activeCharacters, limit) {
    const settings = extension_settings[extensionName];

    if (settings.smartRetrievalEnabled) {
        return selectRelevantMemoriesSmart(memories, recentContext, characterName, limit);
    } else {
        return selectRelevantMemoriesSimple(memories, recentContext, characterName, activeCharacters, limit);
    }
}

/**
 * Get relationship context for active characters
 */
function getRelationshipContext(data, povCharacter, activeCharacters) {
    const relationships = data[RELATIONSHIPS_KEY] || {};
    const relevant = [];

    for (const [key, rel] of Object.entries(relationships)) {
        // Check if this relationship involves POV character and any active character
        const involvesPov = rel.character_a === povCharacter || rel.character_b === povCharacter;
        const involvesActive = activeCharacters.some(c =>
            c !== povCharacter && (rel.character_a === c || rel.character_b === c)
        );

        if (involvesPov && involvesActive) {
            const other = rel.character_a === povCharacter ? rel.character_b : rel.character_a;
            relevant.push({
                character: other,
                trust: rel.trust_level,
                tension: rel.tension_level,
                type: rel.relationship_type,
            });
        }
    }

    return relevant;
}

/**
 * Format context for injection into prompt
 */
function formatContextForInjection(memories, relationships, emotionalState, characterName, tokenBudget) {
    const lines = [];

    // Get current message number for context
    const context = getContext();
    const currentMessageNum = context.chat?.length || 0;

    lines.push(`[${characterName}'s Memory & State]`);
    lines.push(`(Current message: #${currentMessageNum})`);
    lines.push('');

    // Emotional state
    if (emotionalState && emotionalState !== 'neutral') {
        lines.push(`Current emotional state: ${emotionalState}`);
        lines.push('');
    }

    // Relationships
    if (relationships && relationships.length > 0) {
        lines.push('Relationships with present characters:');
        for (const rel of relationships) {
            const trustDesc = rel.trust >= 7 ? 'high trust' : rel.trust <= 3 ? 'low trust' : 'moderate trust';
            const tensionDesc = rel.tension >= 7 ? 'high tension' : rel.tension >= 4 ? 'some tension' : '';
            lines.push(`- ${rel.character}: ${rel.type || 'acquaintance'} (${trustDesc}${tensionDesc ? ', ' + tensionDesc : ''})`);
        }
        lines.push('');
    }

    // Memories - sorted by sequence (chronological order) with message numbers
    if (memories && memories.length > 0) {
        // Sort by sequence number (earlier events first)
        const sortedMemories = [...memories].sort((a, b) => {
            const seqA = a.sequence ?? a.created_at ?? 0;
            const seqB = b.sequence ?? b.created_at ?? 0;
            return seqA - seqB;
        });

        lines.push('Relevant memories (in chronological order):');
        sortedMemories.forEach((memory, index) => {
            const prefix = memory.is_secret ? '[Secret] ' : '';
            // Get message number(s) for this memory
            const msgIds = memory.message_ids || [];
            let msgLabel = '';
            if (msgIds.length === 1) {
                msgLabel = `(msg #${msgIds[0]})`;
            } else if (msgIds.length > 1) {
                const minMsg = Math.min(...msgIds);
                const maxMsg = Math.max(...msgIds);
                msgLabel = `(msgs #${minMsg}-${maxMsg})`;
            }
            // Importance indicator: ★ for each level (1-5)
            const importance = memory.importance || 3;
            const importanceLabel = '★'.repeat(importance);
            lines.push(`${index + 1}. ${msgLabel} [${importanceLabel}] ${prefix}${memory.summary}`);
        });
    }

    lines.push(`[End ${characterName}'s Memory]`);

    // Rough token estimate (4 chars per token)
    let result = lines.join('\n');
    const estimatedTokens = result.length / 4;

    if (estimatedTokens > tokenBudget) {
        // Truncate memories if needed
        const overhead = (lines.slice(0, 5).join('\n').length + lines.slice(-1).join('\n').length) / 4;
        const availableForMemories = tokenBudget - overhead;

        const truncatedMemories = [];
        let currentTokens = 0;

        for (const memory of memories) {
            const memoryTokens = (memory.summary?.length || 0) / 4 + 5;
            if (currentTokens + memoryTokens <= availableForMemories) {
                truncatedMemories.push(memory);
                currentTokens += memoryTokens;
            } else {
                break;
            }
        }

        // Rebuild with truncated memories
        return formatContextForInjection(truncatedMemories, relationships, emotionalState, characterName, tokenBudget * 2);
    }

    return result;
}

/**
 * Inject retrieved context into the prompt
 * @param {string} contextText - Formatted context to inject
 */
function injectContext(contextText) {
    if (!contextText) {
        // Clear the injection if no context
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    setExtensionPrompt(
        extensionName,
        contextText,
        extension_prompt_types.IN_CHAT,  // IN_CHAT works better for persistent injection
        0  // depth (0 = at the end of chat context)
    );

    log('Context injected into prompt');
}

/**
 * Update the injection (for automatic mode)
 * This rebuilds and re-injects context based on current state
 * Uses smart retrieval if enabled in settings
 * @param {string} pendingUserMessage - Optional user message not yet in chat (from textarea during pre-generation)
 */
async function updateInjection(pendingUserMessage = '') {
    const settings = extension_settings[extensionName];

    // Clear injection if disabled or not in automatic mode
    if (!settings.enabled || !settings.automaticMode) {
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const data = getOpenVaultData();
    const memories = data[MEMORIES_KEY] || [];

    if (memories.length === 0) {
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const activeCharacters = getActiveCharacters();

    // Get POV context (different behavior for group chat vs narrator mode)
    const { povCharacters, isGroupChat } = getPOVContext();

    // Collect known events from all POV characters
    const knownEventIds = new Set();
    for (const charName of povCharacters) {
        const charState = data[CHARACTERS_KEY]?.[charName];
        if (charState?.known_events) {
            for (const eventId of charState.known_events) {
                knownEventIds.add(eventId);
            }
        }
    }

    // Filter memories by POV - memories that ANY of the POV characters know
    const povCharactersLower = povCharacters.map(c => c.toLowerCase());
    const accessibleMemories = memories.filter(m => {
        if (m.witnesses?.some(w => povCharactersLower.includes(w.toLowerCase()))) return true;
        if (!m.is_secret && m.characters_involved?.some(c => povCharactersLower.includes(c.toLowerCase()))) return true;
        if (knownEventIds.has(m.id)) return true;
        return false;
    });

    // Fallback to all memories if POV filter is too strict
    let memoriesToUse = accessibleMemories;
    if (accessibleMemories.length === 0 && memories.length > 0) {
        log('Injection: POV filter returned 0, using all memories');
        memoriesToUse = memories;
    }

    if (memoriesToUse.length === 0) {
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    // Use first POV character for formatting (or context name for narrator mode)
    const primaryCharacter = isGroupChat ? povCharacters[0] : context.name2;

    // Get recent context for relevance matching
    let recentMessages = context.chat
        .filter(m => !m.is_system)
        .slice(-5)
        .map(m => m.mes)
        .join('\n');

    // Include pending user message if provided (for pre-generation retrieval)
    // This ensures the retrieval AI can see what the user just typed
    if (pendingUserMessage) {
        recentMessages = recentMessages + '\n\n[User is about to say]: ' + pendingUserMessage;
        log(`Including pending user message in retrieval context`);
    }

    // Select relevant memories - uses smart retrieval if enabled in settings
    const relevantMemories = await selectRelevantMemories(
        memoriesToUse,
        recentMessages,
        primaryCharacter,
        activeCharacters,
        settings.maxMemoriesPerRetrieval
    );

    if (!relevantMemories || relevantMemories.length === 0) {
        setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    // Get relationship and emotional context
    const relationshipContext = getRelationshipContext(data, primaryCharacter, activeCharacters);
    const primaryCharState = data[CHARACTERS_KEY]?.[primaryCharacter];
    const emotionalState = primaryCharState?.current_emotion || 'neutral';

    // Format header based on mode
    const headerName = isGroupChat ? primaryCharacter : 'Scene';

    // Format and inject
    const formattedContext = formatContextForInjection(
        relevantMemories,
        relationshipContext,
        emotionalState,
        headerName,
        settings.tokenBudget
    );

    if (formattedContext) {
        injectContext(formattedContext);
        log(`Injection updated: ${relevantMemories.length} memories`);
    }
}

/**
 * Get active characters in the conversation
 * @returns {string[]}
 */
function getActiveCharacters() {
    const context = getContext();
    const characters = [context.name2]; // Main character

    // Add user
    if (context.name1) {
        characters.push(context.name1);
    }

    // Add group members if in group chat
    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        if (group?.members) {
            for (const member of group.members) {
                const char = context.characters?.find(c => c.avatar === member);
                if (char?.name && !characters.includes(char.name)) {
                    characters.push(char.name);
                }
            }
        }
    }

    return characters;
}

/**
 * Detect characters present in recent messages (for narrator mode)
 * Scans message content for character names from stored memories
 * @param {number} messageCount - Number of recent messages to scan
 * @returns {string[]} - List of detected character names
 */
function detectPresentCharactersFromMessages(messageCount = 2) {
    const context = getContext();
    const chat = context.chat || [];
    const data = getOpenVaultData();

    // Get all known character names from memories
    const knownCharacters = new Set();
    for (const memory of (data[MEMORIES_KEY] || [])) {
        for (const char of (memory.characters_involved || [])) {
            knownCharacters.add(char.toLowerCase());
        }
        for (const witness of (memory.witnesses || [])) {
            knownCharacters.add(witness.toLowerCase());
        }
    }
    // Also add from character states
    for (const charName of Object.keys(data[CHARACTERS_KEY] || {})) {
        knownCharacters.add(charName.toLowerCase());
    }

    // Add user and main character
    if (context.name1) knownCharacters.add(context.name1.toLowerCase());
    if (context.name2) knownCharacters.add(context.name2.toLowerCase());

    // Scan recent messages
    const recentMessages = chat
        .filter(m => !m.is_system)
        .slice(-messageCount);

    const presentCharacters = new Set();

    for (const msg of recentMessages) {
        const text = (msg.mes || '').toLowerCase();
        const name = (msg.name || '').toLowerCase();

        // Add message sender
        if (name) {
            presentCharacters.add(name);
        }

        // Scan message content for character names
        for (const charName of knownCharacters) {
            if (text.includes(charName)) {
                presentCharacters.add(charName);
            }
        }
    }

    // Convert back to original case by finding matches
    const result = [];
    for (const lowerName of presentCharacters) {
        // Try to find original casing from data
        for (const charName of Object.keys(data[CHARACTERS_KEY] || {})) {
            if (charName.toLowerCase() === lowerName) {
                result.push(charName);
                break;
            }
        }
        // Fallback: check context names
        if (!result.some(r => r.toLowerCase() === lowerName)) {
            if (context.name1?.toLowerCase() === lowerName) result.push(context.name1);
            else if (context.name2?.toLowerCase() === lowerName) result.push(context.name2);
            else result.push(lowerName); // Keep lowercase if no match found
        }
    }

    log(`Detected present characters: ${result.join(', ')}`);
    return result;
}

/**
 * Get POV characters for memory filtering
 * - Group chat: Use the responding character's name (true POV)
 * - Solo chat: Use characters detected in recent messages (narrator mode)
 * @returns {{ povCharacters: string[], isGroupChat: boolean }}
 */
function getPOVContext() {
    const context = getContext();
    const isGroupChat = !!context.groupId;

    if (isGroupChat) {
        // Group chat: Use the specific responding character
        log(`Group chat mode: POV character = ${context.name2}`);
        return {
            povCharacters: [context.name2],
            isGroupChat: true
        };
    } else {
        // Solo chat (narrator mode): Detect characters from recent messages
        const presentCharacters = detectPresentCharactersFromMessages(2);

        // If no characters detected, fall back to context names
        if (presentCharacters.length === 0) {
            presentCharacters.push(context.name2);
            if (context.name1) presentCharacters.push(context.name1);
        }

        log(`Narrator mode: POV characters = ${presentCharacters.join(', ')}`);
        return {
            povCharacters: presentCharacters,
            isGroupChat: false
        };
    }
}

/**
 * Delete current chat's OpenVault data
 */
async function deleteCurrentChatData() {
    if (!confirm('Are you sure you want to delete all OpenVault data for this chat?')) {
        return;
    }

    const context = getContext();
    if (context.chatMetadata) {
        delete context.chatMetadata[METADATA_KEY];
        await saveChatConditional();
    }

    toastr.success('Chat memories deleted', 'OpenVault');
    refreshAllUI();
}

/**
 * Delete all OpenVault data (requires typing DELETE)
 */
async function deleteAllData() {
    const confirmation = prompt('Type DELETE to confirm deletion of all OpenVault data:');
    if (confirmation !== 'DELETE') {
        toastr.warning('Deletion cancelled', 'OpenVault');
        return;
    }

    // This would need to iterate through all chats - for now just clear current
    const context = getContext();
    if (context.chatMetadata) {
        delete context.chatMetadata[METADATA_KEY];
        await saveChatConditional();
    }

    toastr.success('All data deleted', 'OpenVault');
    refreshAllUI();
}

/**
 * Set the status indicator
 * @param {string} status - 'ready', 'extracting', 'retrieving', 'error'
 */
function setStatus(status) {
    const $indicator = $('#openvault_status');
    $indicator.removeClass('ready extracting retrieving error');
    $indicator.addClass(status);

    const statusText = {
        ready: 'Ready',
        extracting: 'Extracting...',
        retrieving: 'Retrieving...',
        error: 'Error',
    };

    $indicator.text(statusText[status] || status);
}

/**
 * Log message if debug mode is enabled
 * @param {string} message
 */
function log(message) {
    const settings = extension_settings[extensionName];
    if (settings?.debugMode) {
        console.log(`[OpenVault] ${message}`);
    }
}

/**
 * Register slash commands
 */
function registerCommands() {
    const context = getContext();
    const parser = context.SlashCommandParser;
    const command = context.SlashCommand;

    // /openvault-extract - Extract memories from recent messages
    parser.addCommandObject(command.fromProps({
        name: 'openvault-extract',
        callback: async () => {
            await extractMemories();
            return '';
        },
        helpString: 'Extract memories from recent messages',
    }));

    // /openvault-retrieve - Retrieve and inject context
    parser.addCommandObject(command.fromProps({
        name: 'openvault-retrieve',
        callback: async () => {
            await retrieveAndInjectContext();
            return '';
        },
        helpString: 'Retrieve relevant context and inject into prompt',
    }));

    // /openvault-status - Show current status
    parser.addCommandObject(command.fromProps({
        name: 'openvault-status',
        callback: async () => {
            const settings = extension_settings[extensionName];
            const data = getOpenVaultData();
            const status = `OpenVault: ${settings.enabled ? 'Enabled' : 'Disabled'}, Mode: ${settings.automaticMode ? 'Automatic' : 'Manual'}, Memories: ${data[MEMORIES_KEY]?.length || 0}`;
            toastr.info(status, 'OpenVault');
            return status;
        },
        helpString: 'Show OpenVault status',
    }));

    log('Slash commands registered');
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    // Check SillyTavern version
    const response = await fetch('/version');
    const version = await response.json();
    const [major, minor] = version.pkgVersion.split('.').map(Number);

    if (minor < 13) {
        toastr.error('OpenVault requires SillyTavern 1.13.0 or later', 'OpenVault');
        return;
    }

    // Initialize on app ready
    eventSource.on(event_types.APP_READY, async () => {
        await loadSettings();
        registerCommands();
        updateEventListeners();
        setStatus('ready');
        log('Extension initialized');
    });

    // Handle chat changes
    eventSource.on(event_types.CHAT_CHANGED, async (chatId) => {
        if (!chatId) return;
        log(`Chat changed to: ${chatId}`);
        refreshAllUI();
        setStatus('ready');
    });
});
