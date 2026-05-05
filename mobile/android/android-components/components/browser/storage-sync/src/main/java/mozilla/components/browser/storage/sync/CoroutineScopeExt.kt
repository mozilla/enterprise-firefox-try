/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.browser.storage.sync

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

/**
 * Convenience function to get the dispatcher component of a coroutine scope
 *
 * This is because using a coroutine context with a Job in a [kotlinx.coroutines.withContext]
 * call can break structured concurrency, which we need to be able to ensure that cancellation
 * behaves as it should.
 */
@OptIn(ExperimentalStdlibApi::class)
internal val CoroutineScope.dispatcher: CoroutineDispatcher
    get() = coroutineContext[CoroutineDispatcher] ?: Dispatchers.IO
