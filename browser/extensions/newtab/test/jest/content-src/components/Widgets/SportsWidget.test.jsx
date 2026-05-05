/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, fireEvent } from "@testing-library/react";
import { INITIAL_STATE } from "common/Reducers.sys.mjs";
import { actionTypes as at } from "common/Actions.mjs";
import { WrapWithProvider } from "test/jest/test-utils";
import { SportsWidget } from "content-src/components/Widgets/SportsWidget/SportsWidget";

const PREF_NOVA_ENABLED = "nova.enabled";
const PREF_SPORTS_WIDGET_SIZE = "widgets.sportsWidget.size";

const defaultProps = {
  dispatch: jest.fn(),
  handleUserInteraction: jest.fn(),
};

function makeState(prefOverrides = {}) {
  return {
    ...INITIAL_STATE,
    Prefs: {
      ...INITIAL_STATE.Prefs,
      values: {
        ...INITIAL_STATE.Prefs.values,
        [PREF_NOVA_ENABLED]: true,
        [PREF_SPORTS_WIDGET_SIZE]: "medium",
        ...prefOverrides,
      },
    },
    SportsWidget: { data: null, initialized: false },
  };
}

describe("<SportsWidget>", () => {
  it("should render the sports widget", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(container.querySelector(".sports")).toBeInTheDocument();
  });

  it("should return null when nova.enabled is false", () => {
    const { container } = render(
      <WrapWithProvider state={makeState({ [PREF_NOVA_ENABLED]: false })}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(container.querySelector(".sports")).not.toBeInTheDocument();
  });

  it("should apply the medium-widget class by default", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(".sports.medium-widget")
    ).toBeInTheDocument();
  });

  it("should apply the large-widget class when size pref is large", () => {
    const { container } = render(
      <WrapWithProvider
        state={makeState({ [PREF_SPORTS_WIDGET_SIZE]: "large" })}
      >
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(container.querySelector(".sports.large-widget")).toBeInTheDocument();
  });

  it("should always render the intro wrapper", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(".sports-intro-wrapper")
    ).toBeInTheDocument();
  });

  it("should show the keep-tabs title", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector("[data-l10n-id='newtab-sports-widget-keep-tabs']")
    ).toBeInTheDocument();
  });

  it("should render the view-schedule button", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(
        "[data-l10n-id='newtab-sports-widget-view-schedule']"
      )
    ).toBeInTheDocument();
  });

  it("should apply size=small to buttons on medium size", () => {
    const { container } = render(
      <WrapWithProvider state={makeState()}>
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(".sports-view-schedule").getAttribute("size")
    ).toBe("small");
    expect(
      container.querySelector(".sports-follow-teams").getAttribute("size")
    ).toBe("small");
  });

  it("should not apply size=small to buttons on large size", () => {
    const { container } = render(
      <WrapWithProvider
        state={makeState({ [PREF_SPORTS_WIDGET_SIZE]: "large" })}
      >
        <SportsWidget {...defaultProps} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(".sports-view-schedule").getAttribute("size")
    ).toBeNull();
    expect(
      container.querySelector(".sports-follow-teams").getAttribute("size")
    ).toBeNull();
  });
});

describe("<SportsWidget> telemetry", () => {
  let dispatch;
  let handleUserInteraction;

  beforeEach(() => {
    dispatch = jest.fn();
    handleUserInteraction = jest.fn();
  });

  function renderWidget(size = "medium") {
    return render(
      <WrapWithProvider state={makeState({ [PREF_SPORTS_WIDGET_SIZE]: size })}>
        <SportsWidget
          dispatch={dispatch}
          handleUserInteraction={handleUserInteraction}
        />
      </WrapWithProvider>
    );
  }

  it("should dispatch view_schedule telemetry when view-schedule is clicked", () => {
    const { container } = renderWidget();
    fireEvent.click(
      container.querySelector(
        "[data-l10n-id='newtab-sports-widget-view-schedule']"
      )
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: at.WIDGETS_USER_EVENT,
        data: expect.objectContaining({
          widget_source: "widget",
          user_action: "view_schedule",
        }),
      })
    );
    expect(handleUserInteraction).toHaveBeenCalledWith("sportsWidget");
  });

  it("should dispatch follow_teams telemetry when the follow-teams button is clicked", () => {
    const { container } = renderWidget();
    fireEvent.click(container.querySelector(".sports-follow-teams"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: at.WIDGETS_USER_EVENT,
        data: expect.objectContaining({
          widget_source: "widget",
          user_action: "follow_teams",
        }),
      })
    );
    expect(handleUserInteraction).toHaveBeenCalledWith("sportsWidget");
  });
});
