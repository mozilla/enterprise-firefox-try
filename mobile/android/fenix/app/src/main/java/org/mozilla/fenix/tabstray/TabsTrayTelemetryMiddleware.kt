/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray

import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import mozilla.telemetry.glean.private.NoExtras
import org.mozilla.experiments.nimbus.NimbusEventStore
import org.mozilla.fenix.GleanMetrics.Metrics
import org.mozilla.fenix.GleanMetrics.TabSearch
import org.mozilla.fenix.GleanMetrics.TabsTray
import org.mozilla.fenix.components.metrics.MetricsUtils
import org.mozilla.fenix.components.metrics.MetricsUtils.BookmarkAction.Source
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.action.TabSearchAction
import org.mozilla.fenix.tabstray.redux.action.TabsTrayAction
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState

/**
 * Middleware that records telemetry events for the Tabs Tray feature.
 *
 * @param nimbusEventStore [NimbusEventStore] for recording events to use in behavioral targeting.
 */
class TabsTrayTelemetryMiddleware(
    private val nimbusEventStore: NimbusEventStore,
) : Middleware<TabsTrayState, TabsTrayAction> {

    private var shouldReportInactiveTabMetrics: Boolean = true

    override fun invoke(
        store: Store<TabsTrayState, TabsTrayAction>,
        next: (TabsTrayAction) -> Unit,
        action: TabsTrayAction,
    ) {
        when (action) {
            is TabGroupAction -> handleTabGroupAction(store = store, action = action)
            is TabSearchAction -> handleTabSearchAction(action = action)
            is TabsTrayAction.NavigateBackInvoked -> handleNavigateBackInvoked(state = store.state)
            else -> handleGeneralTabsTrayAction(action = action)
        }
        next(action)
    }

    private fun handleGeneralTabsTrayAction(action: TabsTrayAction) {
        when (action) {
            is TabsTrayAction.TabDataUpdateReceived -> {
                if (shouldReportInactiveTabMetrics) {
                    shouldReportInactiveTabMetrics = false

                    TabsTray.hasInactiveTabs.record(
                        TabsTray.HasInactiveTabsExtra(action.tabStorageUpdate.inactiveTabs.size),
                    )
                    Metrics.inactiveTabsCount.set(action.tabStorageUpdate.inactiveTabs.size.toLong())
                }
            }

            is TabsTrayAction.EnterSelectMode -> {
                TabsTray.enterMultiselectMode.record(TabsTray.EnterMultiselectModeExtra(false))
            }

            is TabsTrayAction.AddSelectTab -> {
                TabsTray.enterMultiselectMode.record(TabsTray.EnterMultiselectModeExtra(true))
            }

            is TabsTrayAction.TabAutoCloseDialogShown -> {
                TabsTray.autoCloseSeen.record(NoExtras())
            }

            is TabsTrayAction.ShareAllNormalTabs,
            is TabsTrayAction.ShareAllPrivateTabs,
                -> {
                TabsTray.shareAllTabs.record(NoExtras())
            }

            is TabsTrayAction.CloseAllNormalTabs,
            is TabsTrayAction.CloseAllPrivateTabs,
                -> {
                TabsTray.closeAllTabs.record(NoExtras())
            }

            is TabsTrayAction.BookmarkSelectedTabs -> {
                TabsTray.bookmarkSelectedTabs.record(TabsTray.BookmarkSelectedTabsExtra(tabCount = action.tabCount))
                MetricsUtils.recordBookmarkAddMetric(Source.TABS_TRAY, nimbusEventStore, count = action.tabCount)
            }

            is TabsTrayAction.ThreeDotMenuShown -> {
                TabsTray.menuOpened.record(NoExtras())
            }

            is TabsTrayAction.TabSearchClicked -> {
                TabSearch.tabSearchIconClicked.record(NoExtras())
            }

            else -> {
                // no-op
            }
        }
    }

    private fun handleTabGroupAction(
        store: Store<TabsTrayState, TabsTrayAction>,
        action: TabGroupAction,
    ) {
        when (action) {
            is TabGroupAction.SaveClicked -> {
                val isEditing = store.state.tabGroupState.formState?.inEditState == true
                if (!isEditing) {
                    TabsTray.tabGroupCreated.record(NoExtras())
                }
            }

            is TabGroupAction.DeleteConfirmed -> {
                TabsTray.tabGroupDeleted.record(NoExtras())
            }

            is TabGroupAction.TabAddedToGroup -> {
                TabsTray.tabAddedToGroup.record(
                    TabsTray.TabAddedToGroupExtra(tabCount = 1),
                )
            }

            is TabGroupAction.SelectedTabsAddedToGroup -> {
                TabsTray.tabAddedToGroup.record(
                    TabsTray.TabAddedToGroupExtra(tabCount = store.state.mode.selectedTabs.size),
                )
            }

            is TabGroupAction.TabGroupClicked -> {
                if (store.state.mode is TabsTrayState.Mode.Normal) {
                    TabsTray.tabGroupOpened.record(NoExtras())
                }
            }

            is TabGroupAction.AddToNewTabGroup -> {
                Metrics.tabGroupCreationMode["menu"].add()
            }

            else -> {
                // no-op
            }
        }
    }

    private fun handleTabSearchAction(action: TabSearchAction) {
        when (action) {
            is TabSearchAction.SearchResultClicked -> {
                TabSearch.resultClicked.record(NoExtras())
            }

            else -> {
                // no-op
            }
        }
    }

    private fun handleNavigateBackInvoked(
        state: TabsTrayState,
    ) {
        val topDestination = state.backStack.lastOrNull()
        val isEditing = state.tabGroupState.formState?.inEditState == true
        requireNotNull(topDestination) { "The backstack cannot be empty" }

        when (topDestination) {
            is TabManagerNavDestination.TabSearch -> {
                TabSearch.navigateBackIconClicked.record(NoExtras())
            }

            is TabManagerNavDestination.AddToTabGroup -> {
                TabsTray.tabGroupCreateCancel.record(NoExtras())
            }

            is TabManagerNavDestination.EditTabGroup -> {
                if (!isEditing) {
                    TabsTray.tabGroupCreateCancel.record(NoExtras())
                }
            }

            else -> {
                // no-op
            }
        }
    }
}
