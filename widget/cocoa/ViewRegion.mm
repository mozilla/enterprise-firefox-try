/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ViewRegion.h"
#import <Cocoa/Cocoa.h>

#include "nsCocoaWindow.h"

using namespace mozilla;

ViewRegion::~ViewRegion() {
  VTRecord(VT_VIEW_REGION_DESTRUCTOR);
  for (NSView* view : mViews) {
    [view removeFromSuperview];
    [view release];
  }
}

bool ViewRegion::UpdateRegion(const LayoutDeviceIntRegion& aRegion,
                              const nsCocoaWindow& aCoordinateConverter,
                              NSView* aContainerView,
                              NSView* (^aViewCreationCallback)()) {
  if (mRegion == aRegion) {
    return false;
  }

  VTRecord(VT_VIEW_REGION_ENTER);

  // We need to construct the required region using as many EffectViews
  // as necessary. We try to update the geometry of existing views if
  // possible, or create new ones or remove old ones if the number of
  // rects in the region has changed.

  nsTArray<NSView*> viewsToRecycle = std::move(mViews);
  // The mViews array is now empty.

  size_t viewsRecycled = 0;
  for (auto iter = aRegion.RectIter(); !iter.Done(); iter.Next()) {
    NSRect rect = aCoordinateConverter.DevPixelsToCocoaPoints(iter.Get());
    NSView* view = nil;
    if (viewsRecycled < viewsToRecycle.Length()) {
      view = viewsToRecycle[viewsRecycled++];
    } else {
      view = aViewCreationCallback();
      VTRecord(VT_VIEW_REGION_ADD_SUBVIEW);
      [aContainerView addSubview:view];
    }
    if (!NSEqualRects(rect, view.frame)) {
      view.frame = rect;
    }
    view.needsDisplay = YES;
    mViews.AppendElement(view);
  }
  for (NSView* view : Span(viewsToRecycle).From(viewsRecycled)) {
    // Our new region is made of fewer rects than the old region, so we can
    // remove this view. Remove it from its superview and also remove our
    // reference to it.
    VTRecord(VT_VIEW_REGION_REMOVE_SUBVIEW);
    [view removeFromSuperview];
    [view release];
  }

  VTRecord(VT_VIEW_REGION_EXIT);
  mRegion = aRegion;
  return true;
}
