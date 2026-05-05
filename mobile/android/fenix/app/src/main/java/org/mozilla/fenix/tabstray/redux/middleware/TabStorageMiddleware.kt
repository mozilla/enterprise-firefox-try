/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.middleware

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted.Companion.Eagerly
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import mozilla.components.browser.state.state.TabSessionState
import mozilla.components.feature.tabs.TabsUseCases.MoveTabsUseCase
import mozilla.components.feature.tabs.TabsUseCases.RemoveTabsUseCase
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.utils.DateTimeProvider
import mozilla.components.support.utils.DefaultDateTimeProvider
import org.mozilla.fenix.tabgroups.storage.database.StoredTabGroup
import org.mozilla.fenix.tabgroups.storage.repository.TabGroupRepository
import org.mozilla.fenix.tabstray.data.TabData
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.data.TabStorageUpdate
import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction.InitAction
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction.TabDataUpdateReceived
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction.TabsStorageAction
import org.mozilla.fenix.tabstray.redux.state.TabGroupFormState
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState

private typealias TabItemId = String
private typealias TabGroupMap = HashMap<TabItemId, TabsTrayItem.TabGroup>

/**
 * Value class representing the combined data model of all data inputs before being transformed.
 **/
@JvmInline
private value class CombinedTabData(
    private val combinedData: Triple<TabData, List<StoredTabGroup>, Map<String, String>>,
) {
    val tabs: List<TabSessionState>
        get() = combinedData.first.tabs

    val selectedTabId: String?
        get() = combinedData.first.selectedTabId

    val tabGroups: List<StoredTabGroup>
        get() = combinedData.second

    val tabGroupAssignments: Map<String, String>
        get() = combinedData.third
}

/**
 * [Middleware] that reacts to [TabsTrayAction] and performs storage side effects.
 *
 * @param inactiveTabsEnabled Whether the inactive tabs feature is enabled.
 * @param tabGroupsEnabled Whether the inactive tabs feature is enabled.
 * @param tabDataFlow [Flow] used to observe tab data.
 * @param tabGroupRepository The [TabGroupRepository] used to read/write tab group data.
 * @param removeTabsUseCase The [RemoveTabsUseCase] used to delete the tabs in a tab group.
 * @param moveTabsUseCase The [MoveTabsUseCase] used to sequence tabs next to each other in the underlying tab storage.
 * @param dateTimeProvider The [DateTimeProvider] that will be used to get the current date.
 * @param scope The [CoroutineScope] for running the tab data transformation off of the main thread.
 * @param mainScope The [CoroutineScope] used for returning to the main thread.
 **/
class TabStorageMiddleware(
    private val inactiveTabsEnabled: Boolean,
    private val tabGroupsEnabled: Boolean,
    private val tabDataFlow: Flow<TabData>,
    private val tabGroupRepository: TabGroupRepository,
    private val removeTabsUseCase: RemoveTabsUseCase,
    private val moveTabsUseCase: MoveTabsUseCase,
    private val dateTimeProvider: DateTimeProvider = DefaultDateTimeProvider(),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
    private val mainScope: CoroutineScope = CoroutineScope(Dispatchers.Main),
) : Middleware<TabsTrayState, TabsTrayAction> {

    private val combinedDataFlow: StateFlow<CombinedTabData> =
        if (tabGroupsEnabled) {
            combine(
                flow = tabDataFlow.distinctUntilChanged(),
                flow2 = tabGroupRepository.observeTabGroups().distinctUntilChanged(),
                flow3 = tabGroupRepository.observeTabGroupAssignments().distinctUntilChanged(),
            ) { tabData, tabGroups, tabGroupAssignments ->
                CombinedTabData(combinedData = Triple(tabData, tabGroups, tabGroupAssignments))
            }.toCombinedDataStateFlow()
        } else {
            tabDataFlow
                .map { CombinedTabData(combinedData = Triple(it, listOf(), mapOf())) }
                .distinctUntilChanged()
                .toCombinedDataStateFlow()
        }

    private val logger = Logger(tag = "TabStorageMiddleware")

    override fun invoke(
        store: Store<TabsTrayState, TabsTrayAction>,
        next: (TabsTrayAction) -> Unit,
        action: TabsTrayAction,
    ) {
        when (action) {
            is TabsStorageAction -> processAction(
                action = action,
                store = store,
            )

            else -> {}
        }

        next(action)
    }

    private fun processAction(
        action: TabsStorageAction,
        store: Store<TabsTrayState, TabsTrayAction>,
    ) {
        when (action) {
            InitAction -> {
                // Set up the tab data observer and set the Flow collection to the lifetime of main scope
                mainScope.launch {
                    combinedDataFlow.collect { data ->
                        scope.launch {
                            val transformedTabData = transformTabData(
                                tabs = data.tabs,
                                selectedTabId = data.selectedTabId,
                                tabGroups = data.tabGroups,
                                tabGroupAssignments = data.tabGroupAssignments,
                            )

                            mainScope.launch {
                                store.dispatch(TabDataUpdateReceived(tabStorageUpdate = transformedTabData))
                            }
                        }
                    }
                }
            }

            TabGroupAction.SaveClicked -> handleSaveClicked(store)

            is TabGroupAction.SelectedTabsAddedToGroup -> {
                val selectedTabIds = store.state.mode.selectedTabIds
                val selectedTabGroupIds = store.state.mode.selectedTabGroupIds
                val lastTabInGroupId = store.state.lastTabInGroupId(groupId = action.groupId)

                scope.launch {
                    // Sequence the selected tabs after the group's other tabs, if it has any.
                    lastTabInGroupId?.let {
                        sequenceGroupedTabsTogether(
                            tabIds = selectedTabIds,
                            targetTabId = lastTabInGroupId,
                        )
                    }

                    tabGroupRepository.addTabsToTabGroup(
                        tabGroupId = action.groupId,
                        tabIds = selectedTabIds,
                    )

                    // If group(s) were merged, delete them
                    if (selectedTabGroupIds.isNotEmpty()) {
                        tabGroupRepository.deleteTabGroupsById(ids = selectedTabGroupIds)
                    }
                }
            }

            is TabGroupAction.TabAddedToGroup -> {
                handleTabAddedToGroup(groupId = action.groupId, tabId = action.tabId, store = store)
            }

            is TabGroupAction.DeleteConfirmed -> handleDeleteClicked(action.group)

            is TabGroupAction.DragAndDropCompleted -> {
                handleDragAndDrop(action = action, store = store)
            }

            is TabGroupAction.OpenTabGroupClicked -> {
                scope.launch {
                    tabGroupRepository.openTabGroup(tabGroupId = action.group.id)
                }
            }

            is TabGroupAction.CloseTabGroupClicked -> {
                scope.launch {
                    tabGroupRepository.closeTabGroup(tabGroupId = action.group.id)
                }
            }
        }
    }

    /**
     * Handles the drag and drop action based on the source and target types.
     * @param action: The DragAndDropCompleted action
     * @param store: The TabsTraySTore
     */
    private fun handleDragAndDrop(
        action: TabGroupAction.DragAndDropCompleted,
        store: Store<TabsTrayState, TabsTrayAction>,
    ) {
        val dragAndDropItems = lookupDragAndDropItems(action = action, store = store)
        when {
            // Source and target are tabs
            dragAndDropItems.source is TabsTrayItem.Tab && dragAndDropItems.target is TabsTrayItem.Tab -> {
                mainScope.launch {
                    store.dispatch(
                        TabGroupAction.DragAndDropTwoTabs(
                            sourceTabId = action.sourceId,
                            destinationTabId = action.destinationId,
                        ),
                    )
                }
            }
            // Source and target are groups
            dragAndDropItems.source is TabsTrayItem.TabGroup && dragAndDropItems.target is TabsTrayItem.TabGroup -> {
                // todo bug 2019825: handle group merges
            }
            // Source is tab, target is group
            dragAndDropItems.source is TabsTrayItem.Tab && dragAndDropItems.target is TabsTrayItem.TabGroup -> {
                handleTabAddedToGroup(groupId = action.destinationId, tabId = action.sourceId, store = store)
            }
            // Source is group, target is tab
            dragAndDropItems.source is TabsTrayItem.TabGroup && dragAndDropItems.target is TabsTrayItem.Tab -> {
                handleGroupAddedToTab(groupId = action.sourceId, tabId = action.destinationId, store = store)
            }

            else -> {
                logger.warn(
                    "DragAndDropCompleted:  Source or target not found or unsupported.  No action taken.",
                )
            }
        }
    }

    @JvmInline
    private value class DragAndDropItems(private val items: Pair<TabsTrayItem?, TabsTrayItem?>) {
        constructor(source: TabsTrayItem?, target: TabsTrayItem?) : this(
            source to target,
        )

        val source: TabsTrayItem?
            get() = this.items.first
        val target: TabsTrayItem?
            get() = this.items.second
    }

    /**
     * Performs the lookup from id -> TabsTrayItem for source and target in a single linear scan
     */
    private fun lookupDragAndDropItems(
        action: TabGroupAction.DragAndDropCompleted,
        store: Store<TabsTrayState, TabsTrayAction>,
    ): DragAndDropItems {
        var source: TabsTrayItem? = null
        var target: TabsTrayItem? = null
        for (item in store.state.normalTabsState.items) {
            if (item.id == action.sourceId) source = item
            if (item.id == action.destinationId) target = item
            if (source != null && target != null) break
        }
        return DragAndDropItems(
            source = source,
            target = target,
        )
    }

    private fun handleGroupAddedToTab(groupId: String, tabId: String, store: Store<TabsTrayState, TabsTrayAction>) {
        val groupedTabs = store.state.tabGroupState.groups.find { it.id == groupId }?.tabs?.map { it.id }
        scope.launch {
            // Sequence the group's tabs in front of the target tab.
            if (groupedTabs?.isNotEmpty() == true) {
                moveTabsUseCase.invoke(
                    tabIds = groupedTabs,
                    targetTabId = tabId,
                    placeAfter = false,
                )
            }

            tabGroupRepository.addTabGroupAssignment(
                tabId = tabId,
                tabGroupId = groupId,
            )
        }
    }

    private fun handleTabAddedToGroup(groupId: String, tabId: String, store: Store<TabsTrayState, TabsTrayAction>) {
        val lastTabInGroupId = store.state.lastTabInGroupId(groupId = groupId)

        scope.launch {
            // Sequence this tab next to the group's other tabs, if it has any.
            lastTabInGroupId?.let {
                sequenceGroupedTabsTogether(
                    tabIds = listOf(tabId),
                    targetTabId = it,
                )
            }

            tabGroupRepository.addTabGroupAssignment(
                tabId = tabId,
                tabGroupId = groupId,
            )
        }
    }

    private fun transformTabData(
        tabs: List<TabSessionState>,
        selectedTabId: String?,
        tabGroups: List<StoredTabGroup>,
        tabGroupAssignments: Map<TabItemId, String>,
    ): TabStorageUpdate {
        val normalItems: MutableList<TabsTrayItem> = mutableListOf()
        val inactiveTabs: MutableList<TabsTrayItem.Tab> = mutableListOf()
        val privateTabs: MutableList<TabsTrayItem> = mutableListOf()
        val transformedTabGroups = constructTabGroupMaps(tabGroups = tabGroups)
        val groupsIncludedInNormalTabs = hashSetOf<TabItemId>()
        var normalTabCount = 0
        var selectedNormalTabIndex = 0
        var selectedPrivateTabIndex = 0

        tabs.forEach { tab ->
            val displayTab = TabsTrayItem.Tab(
                tab = tab,
                isFocused = tab.id == selectedTabId,
            )
            val assignedGroup = getAssignedGroup(
                tabItemId = displayTab.id,
                tabGroupAssignments = tabGroupAssignments,
                tabGroups = transformedTabGroups,
            )

            when {
                assignedGroup != null -> {
                    normalTabCount++
                    addToTabGroup(
                        tab = displayTab,
                        assignedGroup = assignedGroup,
                        groupsIncludedInNormalTabs = groupsIncludedInNormalTabs,
                        normalTabs = normalItems,
                        updateSelectedTabIndex = { selectedNormalTabIndex = it },
                    )
                }

                displayTab.private -> addToPrivateTabs(
                    tab = displayTab,
                    privateTabs = privateTabs,
                    updateSelectedTabIndex = { selectedPrivateTabIndex = it },
                )

                inactiveTabsEnabled && displayTab.inactive -> {
                    normalTabCount++
                    inactiveTabs.add(displayTab)
                }

                else -> {
                    normalTabCount++
                    addToNormalTabs(
                        tab = displayTab,
                        normalTabs = normalItems,
                        updateSelectedTabIndex = { selectedNormalTabIndex = it },
                    )
                }
            }
        }

        return TabStorageUpdate(
            selectedTabId = selectedTabId,
            normalItems = normalItems,
            normalTabCount = normalTabCount,
            selectedNormalItemIndex = selectedNormalTabIndex,
            inactiveTabs = inactiveTabs,
            privateTabs = privateTabs,
            selectedPrivateItemIndex = selectedPrivateTabIndex,
            tabGroups = transformedTabGroups.values.toList().sortedByDescending { it.lastModified },
        )
    }

    private fun addToTabGroup(
        tab: TabsTrayItem.Tab,
        assignedGroup: TabsTrayItem.TabGroup,
        groupsIncludedInNormalTabs: HashSet<TabItemId>,
        normalTabs: MutableList<TabsTrayItem>,
        updateSelectedTabIndex: (Int) -> Unit,
    ) {
        assignedGroup.tabs.add(tab)

        // We need to separately check & track if the group has already been added to the
        // collection of Normal tab items because normalTabs does not maintain a sort key
        // and cannot be backed by a Map/Set.
        if (!assignedGroup.closed && assignedGroup.id !in groupsIncludedInNormalTabs) {
            normalTabs.add(assignedGroup)
            groupsIncludedInNormalTabs.add(assignedGroup.id)
        }

        if (tab.isFocused) {
            updateSelectedTabIndex(normalTabs.size - 1)
            assignedGroup.isFocused = true
        }
    }

    private fun addToNormalTabs(
        tab: TabsTrayItem.Tab,
        normalTabs: MutableList<TabsTrayItem>,
        updateSelectedTabIndex: (Int) -> Unit,
    ) {
        normalTabs.add(tab)
        if (tab.isFocused) {
            updateSelectedTabIndex(normalTabs.size - 1)
        }
    }

    private fun addToPrivateTabs(
        tab: TabsTrayItem.Tab,
        privateTabs: MutableList<TabsTrayItem>,
        updateSelectedTabIndex: (Int) -> Unit,
    ) {
        privateTabs.add(tab)
        if (tab.isFocused) {
            updateSelectedTabIndex(privateTabs.size - 1)
        }
    }

    private fun getAssignedGroup(
        tabItemId: TabItemId,
        tabGroupAssignments: Map<TabItemId, String>,
        tabGroups: TabGroupMap,
    ): TabsTrayItem.TabGroup? {
        if (!tabGroupsEnabled) return null
        val groupId = tabGroupAssignments[tabItemId]
        return tabGroups[groupId]
    }

    private fun constructTabGroupMaps(
        tabGroups: List<StoredTabGroup>,
    ): TabGroupMap {
        val transformedTabGroups: TabGroupMap = hashMapOf()

        tabGroups.forEach { tabGroup ->
            val safeTheme = tabGroup.theme.toTabGroupTheme()

            transformedTabGroups[tabGroup.id] = TabsTrayItem.TabGroup(
                id = tabGroup.id,
                theme = safeTheme,
                title = tabGroup.title,
                tabs = mutableListOf(),
                closed = tabGroup.closed,
                lastModified = tabGroup.lastModified,
            )
        }

        return transformedTabGroups
    }

    private fun handleSaveClicked(
        store: Store<TabsTrayState, TabsTrayAction>,
    ) {
        val formState = store.state.tabGroupState.formState ?: return
        val mode = store.state.mode
        when (mode) {
            is TabsTrayState.Mode.DragAndDrop -> {
                handleSaveFromDragAndDrop(formState = formState, mode = mode)
            }

            is TabsTrayState.Mode.Normal, is TabsTrayState.Mode.Select -> {
                handleSaveFromMultiSelection(formState = formState, selectedTabIds = store.state.mode.selectedTabIds)
            }
        }
    }

    private fun handleSaveFromDragAndDrop(formState: TabGroupFormState, mode: TabsTrayState.Mode.DragAndDrop) {
        scope.launch {
            val sourceId = mode.sourceId
            val destinationId = mode.destinationId ?: return@launch
            val storedTabGroup = StoredTabGroup(
                title = formState.name,
                theme = formState.theme.toStorageValue(),
                lastModified = dateTimeProvider.currentTimeMillis(),
            )
            // Sequence from the destination
            sequenceGroupedTabsTogether(
                tabIds = listOf(sourceId),
                targetTabId = destinationId,
            )
            tabGroupRepository.createTabGroupWithTabs(
                tabGroup = storedTabGroup,
                tabIds = listOf(sourceId, destinationId),
            )
        }
    }

    private fun handleSaveFromMultiSelection(formState: TabGroupFormState, selectedTabIds: List<String>) {
        scope.launch {
            if (formState.tabGroupId == null) {
                val storedTabGroup = StoredTabGroup(
                    title = formState.name,
                    theme = formState.theme.toStorageValue(),
                    lastModified = dateTimeProvider.currentTimeMillis(),
                )
                if (selectedTabIds.isNotEmpty()) {
                    // Obtain the ID of the selected tab that appears sequentially first in the tab data to sequence
                    // the rest of the selected tabs against it.
                    val sequentiallyFirstTabId = combinedDataFlow
                        .value
                        .tabs
                        .first { it.id in selectedTabIds }
                        .id

                    sequenceGroupedTabsTogether(
                        tabIds = selectedTabIds - sequentiallyFirstTabId,
                        targetTabId = sequentiallyFirstTabId,
                    )

                    tabGroupRepository.createTabGroupWithTabs(
                        tabGroup = storedTabGroup,
                        tabIds = selectedTabIds,
                    )
                } else {
                    tabGroupRepository.addNewTabGroup(storedTabGroup)
                }
            } else {
                tabGroupRepository.updateTabGroup(
                    StoredTabGroup(
                        id = formState.tabGroupId,
                        title = formState.name,
                        theme = formState.theme.toStorageValue(),
                        lastModified = dateTimeProvider.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    private fun handleDeleteClicked(group: TabsTrayItem.TabGroup) {
        scope.launch {
            removeTabsUseCase.invoke(ids = group.tabs.map { it.id })
            tabGroupRepository.deleteTabGroupById(group.id)
        }
    }

    internal fun TabGroupTheme.toStorageValue(): String = name

    internal fun String.toTabGroupTheme() = try {
        TabGroupTheme.valueOf(this)
    } catch (_: IllegalArgumentException) {
        logger.info(message = "Failed to parse TabGroupTheme: $this")
        TabGroupTheme.default
    }

    // Because the sort order is defined by the underlying JSON file, we need to arrange all the group's tabs
    // next to each other in BrowserState so they are correctly sorted/grouped together. This is
    // necessary to ensure the downstream tab group is indexed at the correct spot when displayed
    // in the grid/list.
    private fun sequenceGroupedTabsTogether(
        tabIds: List<String>,
        targetTabId: String,
    ) {
        moveTabsUseCase.invoke(
            tabIds = tabIds,
            targetTabId = targetTabId,
            placeAfter = true,
        )
    }

    private fun Flow<CombinedTabData>.toCombinedDataStateFlow(): StateFlow<CombinedTabData> = stateIn(
        scope = mainScope,
        started = Eagerly,
        initialValue = CombinedTabData(combinedData = Triple(TabData(), listOf(), mapOf())),
    )
}

/**
 * Fetches the ID of the last tab in the group with [groupId], or null if the group is empty.
 */
private fun TabsTrayState.lastTabInGroupId(groupId: String): String? =
    tabGroupState.groups
        .find { it.id == groupId }
        ?.tabs
        ?.lastOrNull()
        ?.id
