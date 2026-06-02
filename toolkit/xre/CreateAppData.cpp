/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsXULAppAPI.h"
#include "nsINIParser.h"
#include "nsIFile.h"
#include "nsURLHelper.h"
#include "mozilla/XREAppData.h"

// This include must appear early in the unified cpp file for toolkit/xre to
// make sure OSX APIs make use of the OSX TextRange before mozilla::TextRange is
// declared and made a global symbol by a "using namespace mozilla" declaration.
#ifdef XP_MACOSX
#  include <Carbon/Carbon.h>
#endif

#if defined(MOZ_ENTERPRISE)
#  include "mozilla/toolkit/components/felt/felt.h"
#endif

using namespace mozilla;

static void ReadString(nsINIParser& parser, const char* section,
                       const char* key, XREAppData::CharPtr& result) {
  nsCString str;
  nsresult rv = parser.GetString(section, key, str);
  if (NS_SUCCEEDED(rv)) {
    result = str.get();
  }
}

struct ReadFlag {
  const char* section;
  const char* key;
  uint32_t flag;
};

static void ReadFlag(nsINIParser& parser, const char* section, const char* key,
                     uint32_t flag, uint32_t& result) {
  char buf[6];  // large enough to hold "false"
  nsresult rv = parser.GetString(section, key, buf, sizeof(buf));
  if (NS_SUCCEEDED(rv) || rv == NS_ERROR_LOSS_OF_SIGNIFICANT_DATA) {
    if (buf[0] == '1' || buf[0] == 't' || buf[0] == 'T') {
      result |= flag;
    }
    if (buf[0] == '0' || buf[0] == 'f' || buf[0] == 'F') {
      result &= ~flag;
    }
  }
}

nsresult XRE_ParseAppData(nsIFile* aINIFile, XREAppData& aAppData) {
  NS_ENSURE_ARG(aINIFile);

  nsresult rv;

  nsINIParser parser;
  rv = parser.Init(aINIFile);
  if (NS_FAILED(rv)) return rv;

  ReadString(parser, "App", "Vendor", aAppData.vendor);
  ReadString(parser, "App", "Name", aAppData.name);
  ReadString(parser, "App", "RemotingName", aAppData.remotingName);
  ReadString(parser, "App", "Version", aAppData.version);
  ReadString(parser, "App", "BuildID", aAppData.buildID);
  ReadString(parser, "App", "ID", aAppData.ID);
  ReadString(parser, "App", "Copyright", aAppData.copyright);
  ReadString(parser, "App", "Profile", aAppData.profile);
  ReadString(parser, "Gecko", "MinVersion", aAppData.minVersion);
  ReadString(parser, "Gecko", "MaxVersion", aAppData.maxVersion);
  ReadString(parser, "Crash Reporter", "ServerURL", aAppData.crashReporterURL);
  ReadString(parser, "App", "UAName", aAppData.UAName);
  ReadString(parser, "AppUpdate", "URL", aAppData.updateURL);
  ReadFlag(parser, "XRE", "EnableProfileMigrator",
           NS_XRE_ENABLE_PROFILE_MIGRATOR, aAppData.flags);
  ReadFlag(parser, "Crash Reporter", "Enabled", NS_XRE_ENABLE_CRASH_REPORTER,
           aAppData.flags);

  return NS_OK;
}

#if defined(MOZ_ENTERPRISE)
static nsresult ParseConsoleUrlFromDistribution(XREAppData& aAppData,
                                                nsACString& consoleUrl) {
  nsCOMPtr<nsIFile> distributionFile;
  nsresult rv = aAppData.xreDirectory->Clone(getter_AddRefs(distributionFile));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = distributionFile->Append(u"distribution"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = distributionFile->Append(u"distribution.ini"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  nsINIParser parser;
  rv = parser.Init(distributionFile);
  NS_ENSURE_SUCCESS(rv, rv);
  rv =
      parser.GetString("Preferences", "enterprise.console.address", consoleUrl);
  return rv;
}

nsresult XRE_ParseEnterpriseServerURL(XREAppData& aAppData,
                                      const char* aServerUrl) {
  nsCString serverUrl(aServerUrl);
  if (!serverUrl.Length()) {
    nsresult rv = ParseConsoleUrlFromDistribution(aAppData, serverUrl);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  if (serverUrl.Last() != '/') {
    serverUrl.Append('/');
  }

  nsCString crashReporterUrl(serverUrl);
  crashReporterUrl.Append("api/browser/crash-reports/submit");
  aAppData.crashReporterURL = crashReporterUrl.get();

  if (is_felt_ui()) {
    nsCString updateUrl(serverUrl);
    nsCString ausUpdateParams(aAppData.updateURL);
    ausUpdateParams.Replace(0, ausUpdateParams.FindChar('%'), "");
    updateUrl.Append("api/browser/updates/");
    updateUrl.Append(ausUpdateParams);
    aAppData.updateURL = updateUrl.get();
  } else {
    aAppData.updateURL = "";
  }

  return NS_OK;
}
#endif
