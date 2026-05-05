/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// eslint-disable-next-line no-unused-vars
import React, { useCallback, useEffect, useRef } from "react";
import { useSelector, batch } from "react-redux";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import { useIntersectionObserver } from "../../../lib/utils";

const USER_ACTION_TYPES = {
  FOLLOW_TEAMS: "follow_teams",
  VIEW_UPCOMING: "view_upcoming",
  VIEW_RESULTS: "view_results",
  VIEW_SCHEDULE: "view_schedule",
  CHANGE_SIZE: "change_size",
  LEARN_MORE: "learn_more",
};

const PREF_NOVA_ENABLED = "nova.enabled";
const PREF_SPORTS_WIDGET_SIZE = "widgets.sportsWidget.size";
const PREF_SPORTS_WIDGET_LIVE_ENABLED = "widgets.sportsWidget.live.enabled";

function SportsWidget({ dispatch, handleUserInteraction }) {
  const prefs = useSelector(state => state.Prefs.values);
  const sportsWidgetData = useSelector(state => state.SportsWidget);

  const widgetSize = prefs[PREF_SPORTS_WIDGET_SIZE] || "medium";
  const liveEnabled = prefs[PREF_SPORTS_WIDGET_LIVE_ENABLED];
  const impressionFired = useRef(false);
  const sizeSubmenuRef = useRef(null);

  const handleIntersection = useCallback(() => {
    if (impressionFired.current) {
      return;
    }
    impressionFired.current = true;
    dispatch(
      ac.AlsoToMain({
        type: at.WIDGETS_IMPRESSION,
        data: {
          widget_name: "sports_widget",
          widget_size: widgetSize,
        },
      })
    );
  }, [dispatch, widgetSize]);

  const widgetRef = useIntersectionObserver(handleIntersection);

  const handleInteraction = useCallback(
    () => handleUserInteraction("sportsWidget"),
    [handleUserInteraction]
  );

  function handleFollowTeams(widgetSource) {
    dispatch(
      ac.OnlyToMain({
        type: at.WIDGETS_USER_EVENT,
        data: {
          widget_name: "sports_widget",
          widget_source: widgetSource,
          user_action: USER_ACTION_TYPES.FOLLOW_TEAMS,
          widget_size: widgetSize,
        },
      })
    );
    handleInteraction();
  }

  function handleViewUpcoming() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            user_action: USER_ACTION_TYPES.VIEW_UPCOMING,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  function handleViewResults() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            user_action: USER_ACTION_TYPES.VIEW_RESULTS,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  function handleSportsWidgetHide() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.SET_PREF,
          data: { name: "widgets.sportsWidget.enabled", value: false },
        })
      );
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_ENABLED,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            enabled: false,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  const handleChangeSize = useCallback(
    size => {
      batch(() => {
        dispatch(
          ac.OnlyToMain({
            type: at.SET_PREF,
            data: { name: PREF_SPORTS_WIDGET_SIZE, value: size },
          })
        );
        dispatch(
          ac.OnlyToMain({
            type: at.WIDGETS_USER_EVENT,
            data: {
              widget_name: "sports_widget",
              widget_source: "context_menu",
              user_action: USER_ACTION_TYPES.CHANGE_SIZE,
              action_value: size,
              widget_size: size,
            },
          })
        );
      });
    },
    [dispatch]
  );

  useEffect(() => {
    const el = sizeSubmenuRef.current;
    if (!el) {
      return undefined;
    }
    const listener = e => {
      const item = e.composedPath().find(node => node.dataset?.size);
      if (item) {
        handleChangeSize(item.dataset.size);
      }
    };
    el.addEventListener("click", listener);
    return () => el.removeEventListener("click", listener);
  }, [handleChangeSize]);

  function handleViewSchedule() {
    dispatch(
      ac.OnlyToMain({
        type: at.WIDGETS_USER_EVENT,
        data: {
          widget_name: "sports_widget",
          widget_source: "widget",
          user_action: USER_ACTION_TYPES.VIEW_SCHEDULE,
          widget_size: widgetSize,
        },
      })
    );
    handleInteraction();
  }

  function handleLearnMore() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.OPEN_LINK,
          data: {
            url: "https://support.mozilla.org/kb/firefox-new-tab-widgets",
          },
        })
      );
      const telemetryData = {
        widget_name: "sports_widget",
        widget_source: "context_menu",
        user_action: USER_ACTION_TYPES.LEARN_MORE,
        widget_size: widgetSize,
      };
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: telemetryData,
        })
      );
    });
  }

  // @nova-cleanup(remove-gate): Remove this guard and PREF_NOVA_ENABLED after Nova ships
  if (!prefs[PREF_NOVA_ENABLED]) {
    return null;
  }

  return (
    <article
      className={`sports widget col-4 ${widgetSize}-widget`}
      ref={el => {
        widgetRef.current = [el];
      }}
    >
      <div className="sports-title-wrapper">
        {/* The empty self-closing div here is used to help center the title, since the context menu also takes up space. */}
        <div />
        <div className="sports-intro-wrapper">
          <h2
            className="sports-intro-title"
            data-l10n-id="newtab-sports-widget-keep-tabs"
          />
          <p
            className="sports-intro-lede"
            data-l10n-id="newtab-sports-widget-get-updates"
          ></p>
        </div>
        <div className="sports-context-menu-wrapper">
          <moz-button
            className="sports-context-menu-button"
            iconSrc="chrome://global/skin/icons/more.svg"
            menuId="sports-context-menu"
            type="ghost"
          />
          <panel-list id="sports-context-menu">
            <panel-item
              data-l10n-id="newtab-sports-widget-menu-follow-teams"
              onClick={() => handleFollowTeams("context_menu")}
            />
            <panel-item
              data-l10n-id="newtab-sports-widget-menu-view-upcoming"
              onClick={handleViewUpcoming}
            />
            <panel-item
              data-l10n-id="newtab-sports-widget-menu-view-results"
              onClick={handleViewResults}
            />
            <panel-item submenu="sports-size-submenu">
              <span data-l10n-id="newtab-widget-menu-change-size"></span>
              <panel-list
                ref={sizeSubmenuRef}
                slot="submenu"
                id="sports-size-submenu"
              >
                {["medium", "large"].map(size => (
                  <panel-item
                    key={size}
                    type="checkbox"
                    checked={widgetSize === size || undefined}
                    data-size={size}
                    data-l10n-id={`newtab-widget-size-${size}`}
                  />
                ))}
              </panel-list>
            </panel-item>
            <panel-item
              data-l10n-id="newtab-widget-menu-hide"
              onClick={handleSportsWidgetHide}
            />
            <panel-item
              data-l10n-id="newtab-sports-widget-menu-learn-more"
              onClick={handleLearnMore}
            />
          </panel-list>
        </div>
      </div>

      <div className="sports-body">
        <div className="sports-buttons-wrapper">
          <moz-button
            type="primary"
            size={widgetSize === "medium" ? "small" : undefined}
            data-l10n-id="newtab-sports-widget-view-schedule"
            className="sports-view-schedule"
            onClick={handleViewSchedule}
          />
          <moz-button
            type="secondary"
            size={widgetSize === "medium" ? "small" : undefined}
            data-l10n-id="newtab-sports-widget-follow-teams"
            className="sports-follow-teams"
            onClick={() => handleFollowTeams("widget")}
          />
        </div>
        {liveEnabled && sportsWidgetData?.initialized && (
          <div className="sports-live-scores">{/* Live scores content */}</div>
        )}
      </div>
    </article>
  );
}

export { SportsWidget };
