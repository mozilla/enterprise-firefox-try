/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MacStringHelpers.h"
#include "nsMacPreferencesReader.h"
#include "nsString.h"

#include "js/JSON.h"
#include "js/RootingAPI.h"
#include "js/Value.h"
#include "mozilla/JSONStringWriteFuncs.h"

NS_IMPL_ISUPPORTS(nsMacPreferencesReader, nsIMacPreferencesReader)

using namespace mozilla;

static void EvaluateDict(JSONWriter* aWriter,
                         NSDictionary<NSString*, id>* aDict);

static void EvaluateArray(JSONWriter* aWriter, NSArray* aArray) {
  for (id elem in aArray) {
    if ([elem isKindOfClass:[NSString class]]) {
      aWriter->StringElement(MakeStringSpan([elem UTF8String]));
    } else if ([elem isKindOfClass:[NSNumber class]]) {
      aWriter->IntElement([elem longLongValue]);
    } else if ([elem isKindOfClass:[NSArray class]]) {
      aWriter->StartArrayElement();
      EvaluateArray(aWriter, elem);
      aWriter->EndArray();
    } else if ([elem isKindOfClass:[NSDictionary class]]) {
      aWriter->StartObjectElement();
      EvaluateDict(aWriter, elem);
      aWriter->EndObject();
    }
  }
}

static void EvaluateDict(JSONWriter* aWriter,
                         NSDictionary<NSString*, id>* aDict) {
  for (NSString* key in aDict) {
    id value = aDict[key];
    if ([value isKindOfClass:[NSString class]]) {
      aWriter->StringProperty(MakeStringSpan([key UTF8String]),
                              MakeStringSpan([value UTF8String]));
    } else if ([value isKindOfClass:[NSNumber class]]) {
      aWriter->IntProperty(MakeStringSpan([key UTF8String]),
                           [value longLongValue]);
    } else if ([value isKindOfClass:[NSArray class]]) {
      aWriter->StartArrayProperty(MakeStringSpan([key UTF8String]));
      EvaluateArray(aWriter, value);
      aWriter->EndArray();
    } else if ([value isKindOfClass:[NSDictionary class]]) {
      aWriter->StartObjectProperty(MakeStringSpan([key UTF8String]));
      EvaluateDict(aWriter, value);
      aWriter->EndObject();
    }
  }
}

// Whether aKey is a managed preference, i.e. forced by a configuration profile
// or MCX, which `defaults write` cannot produce.
static bool IsManagedPreference(NSString* aKey) {
  return CFPreferencesAppValueIsForced((CFStringRef)aKey,
                                       kCFPreferencesCurrentApplication);
}

// The value of aKey in the system-wide preference domain, under
// /Library/Preferences, which only an administrator can write. Autoreleased,
// nil when the domain has no such key.
static id GetSystemPreference(NSString* aKey) {
  CFPropertyListRef value = CFPreferencesCopyValue(
      (CFStringRef)aKey, kCFPreferencesCurrentApplication,
      kCFPreferencesAnyUser, kCFPreferencesCurrentHost);
  if (!value) {
    value = CFPreferencesCopyValue(
        (CFStringRef)aKey, kCFPreferencesCurrentApplication,
        kCFPreferencesAnyUser, kCFPreferencesAnyHost);
  }
  return value ? [(id)value autorelease] : nil;
}

// The value of aKey as NSUserDefaults resolves it. With aAdminOnly, only a
// value an administrator set counts: a managed preference, which wins the
// resolution anyway, or the system-wide value, read directly so that the
// user's own domains (~/Library/Preferences, the command line) can neither
// supply nor shadow it.
static id GetPreference(NSString* aKey, bool aAdminOnly) {
  if (!aAdminOnly || IsManagedPreference(aKey)) {
    return [[NSUserDefaults standardUserDefaults] objectForKey:aKey];
  }
  return GetSystemPreference(aKey);
}

// Every preference NSUserDefaults resolves, or with aAdminOnly only those an
// administrator set, see GetPreference.
static NSDictionary<NSString*, id>* GetPreferences(bool aAdminOnly) {
  NSDictionary<NSString*, id>* all =
      [[NSUserDefaults standardUserDefaults] dictionaryRepresentation];
  if (!aAdminOnly) {
    return all;
  }
  NSMutableDictionary<NSString*, id>* admin = [NSMutableDictionary dictionary];
  for (NSString* key in all) {
    id value = GetPreference(key, true);
    if (value) {
      admin[key] = value;
    }
  }
  return admin;
}

NS_IMETHODIMP
nsMacPreferencesReader::PoliciesEnabled(bool aAdminOnly,
                                        bool* aPoliciesEnabled) {
  NSString* policiesEnabledStr =
      [NSString stringWithUTF8String:ENTERPRISE_POLICIES_ENABLED_KEY];
  if (!aAdminOnly) {
    *aPoliciesEnabled = [[NSUserDefaults standardUserDefaults]
                            boolForKey:policiesEnabledStr] == YES;
    return NS_OK;
  }
  id value = GetPreference(policiesEnabledStr, true);
  *aPoliciesEnabled = [value respondsToSelector:@selector(boolValue)] &&
                      [value boolValue] == YES;
  return NS_OK;
}

NS_IMETHODIMP
nsMacPreferencesReader::ReadPreferences(bool aAdminOnly, JSContext* aCx,
                                        JS::MutableHandle<JS::Value> aResult) {
  JSONStringWriteFunc<nsAutoCString> jsonStr;
  JSONWriter w(jsonStr);
  w.Start();
  EvaluateDict(&w, GetPreferences(aAdminOnly));
  w.End();

  NS_ConvertUTF8toUTF16 jsonStr16(jsonStr.StringCRef());

  JS::RootedValue val(aCx);
  MOZ_ALWAYS_TRUE(JS_ParseJSON(aCx, jsonStr16.get(), jsonStr16.Length(), &val));

  aResult.set(val);
  return NS_OK;
}
