package com.oisint.android.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

sealed interface DeviceLocationResult {
    data class Success(val latitude: Double, val longitude: Double) : DeviceLocationResult
    data object PermissionDenied : DeviceLocationResult
    data object ServicesDisabled : DeviceLocationResult
    data object Unavailable : DeviceLocationResult
    data object Timeout : DeviceLocationResult
}

class DeviceLocationProvider(context: Context) {
    private val appContext = context.applicationContext

    @SuppressLint("MissingPermission")
    suspend fun getCurrentLocation(
        timeoutMillis: Long = LOCATION_TIMEOUT_MILLIS,
        maximumAgeMillis: Long = LOCATION_MAXIMUM_AGE_MILLIS,
    ): DeviceLocationResult {
        if (!hasPermission(appContext)) return DeviceLocationResult.PermissionDenied

        val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        if (!LocationManagerCompat.isLocationEnabled(manager)) {
            return DeviceLocationResult.ServicesDisabled
        }

        val providers = enabledProviders(manager)
        if (providers.isEmpty()) return DeviceLocationResult.Unavailable

        try {
            val cached = providers
                .mapNotNull(manager::getLastKnownLocation)
                .filter { it.isRecent(maximumAgeMillis) }
                .maxByOrNull(Location::getElapsedRealtimeNanos)
            if (cached != null) return cached.toResult()

            // withTimeoutOrNull と awaitLocation はどちらも null を返しうるので、
            // 「時間切れ」と「そもそも購読できなかった」を取り違えないよう包んで区別する
            val awaited = withTimeoutOrNull(timeoutMillis) {
                Optional(awaitLocation(manager, providers))
            } ?: return DeviceLocationResult.Timeout
            return awaited.value?.toResult() ?: DeviceLocationResult.Unavailable
        } catch (_: SecurityException) {
            return DeviceLocationResult.PermissionDenied
        } catch (_: IllegalArgumentException) {
            return DeviceLocationResult.Unavailable
        }
    }

    private fun enabledProviders(manager: LocationManager): List<String> = buildList {
        if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            add(LocationManager.NETWORK_PROVIDER)
        }
        if (
            hasFinePermission(appContext) &&
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
        ) {
            add(LocationManager.GPS_PROVIDER)
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun awaitLocation(
        manager: LocationManager,
        providers: List<String>,
    ): Location? = suspendCancellableCoroutine { continuation ->
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                manager.removeUpdates(this)
                if (continuation.isActive) continuation.resume(location)
            }
        }

        continuation.invokeOnCancellation { manager.removeUpdates(listener) }
        var registered = false
        providers.forEach { provider ->
            try {
                manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                registered = true
            } catch (_: IllegalArgumentException) {
                Unit
            }
        }
        if (!registered && continuation.isActive) continuation.resume(null)
    }

    companion object {
        const val LOCATION_TIMEOUT_MILLIS = 8_000L
        const val LOCATION_MAXIMUM_AGE_MILLIS = 300_000L

        fun hasPermission(context: Context): Boolean =
            hasFinePermission(context) ||
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ) == PackageManager.PERMISSION_GRANTED

        private fun hasFinePermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
    }
}

/** null を値として運ぶための薄いラッパ（タイムアウトの null と取得失敗の null を区別する） */
private class Optional<T>(val value: T?)

private fun Location.isRecent(maximumAgeMillis: Long): Boolean {
    val ageNanos = SystemClock.elapsedRealtimeNanos() - elapsedRealtimeNanos
    return ageNanos in 0..TimeUnit.MILLISECONDS.toNanos(maximumAgeMillis)
}

private fun Location.toResult() = DeviceLocationResult.Success(
    latitude = latitude,
    longitude = longitude,
)
