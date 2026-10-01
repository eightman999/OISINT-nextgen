package com.oisint.android.ui.components

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.location.DeviceLocationProvider
import com.oisint.android.location.DeviceLocationResult
import com.oisint.android.model.LocationSelection
import kotlinx.coroutines.launch

private enum class LocationStatus { Idle, Requesting, Granted, Denied, Error }

/**
 * 場所選択パネル。正典は `src/components/LocationPicker.tsx`（全 318 行）。
 * 現在地取得と手動入力を移植し、地図表示だけは Android 版の対象外とする。
 * 文言は tsx 逐語。testTag は Web testID と同名。
 */
@Composable
fun LocationPickerPanel(
    location: LocationSelection?,
    onLocationChange: (LocationSelection?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val locationProvider = remember(context) { DeviceLocationProvider(context) }
    var status by remember {
        mutableStateOf(if (location?.source == "gps") LocationStatus.Granted else LocationStatus.Idle)
    }
    var errorMessage by remember { mutableStateOf("") }
    var locationJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    // tsx L15-17: source='map' の選択済み値があれば入力欄の初期値にする
    var manualLocation by rememberSaveable {
        mutableStateOf(if (location?.source == "map") location.label else "")
    }

    // tsx L61-67 useManualLocation: trim して空なら何もしない
    val useManualLocation = {
        val label = manualLocation.trim()
        if (label.isNotEmpty()) {
            locationJob?.cancel()
            status = LocationStatus.Idle
            errorMessage = ""
            onLocationChange(LocationSelection(label = label, source = "map"))
        }
    }

    fun acquireLocation() {
        locationJob?.cancel()
        status = LocationStatus.Requesting
        errorMessage = ""
        locationJob = scope.launch {
            when (val result = locationProvider.getCurrentLocation()) {
                is DeviceLocationResult.Success -> {
                    onLocationChange(
                        LocationSelection(
                            label = "現在地付近",
                            source = "gps",
                            latitude = result.latitude,
                            longitude = result.longitude,
                        ),
                    )
                    status = LocationStatus.Granted
                }
                DeviceLocationResult.PermissionDenied -> {
                    status = LocationStatus.Denied
                    errorMessage = "位置情報が許可されていません。下の入力欄から場所を指定できます。"
                }
                DeviceLocationResult.ServicesDisabled -> {
                    status = LocationStatus.Error
                    errorMessage = "端末の位置情報が無効です。位置情報を有効にするか、場所を入力してください。"
                }
                DeviceLocationResult.Timeout -> {
                    status = LocationStatus.Error
                    errorMessage = "現在地の取得がタイムアウトしました。場所を入力して続けてください。"
                }
                DeviceLocationResult.Unavailable -> {
                    status = LocationStatus.Error
                    errorMessage = "現在地を取得できませんでした。場所を入力して続けてください。"
                }
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { permissions ->
        if (permissions.values.any { it }) {
            acquireLocation()
        } else {
            status = LocationStatus.Denied
            errorMessage = "位置情報が許可されていません。下の入力欄から場所を指定できます。"
        }
    }

    val requestGps = {
        if (DeviceLocationProvider.hasPermission(context)) {
            acquireLocation()
        } else {
            status = LocationStatus.Requesting
            errorMessage = ""
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
            )
        }
    }

    // tsx L175-182 container: gap 12 / padding 14 / radius md / borderSoft / bg '#fcfbf8'
    //（'#fcfbf8' は theme.ts に無い tsx 直書き生値。出典: LocationPicker.tsx L181）
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DesignTokens.Radius.md))
            .background(Color(0xFFFCFBF8))
            .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(DesignTokens.Radius.md))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // tsx L78-95 headerRow: row / flex-start / gap 10
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            // tsx L79-83 headerCopy: gap 3
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                // tsx L80 eyebrow: 10sp / 800 / letterSpacing 1.2 / orange
                Text(
                    text = "01 / 場所",
                    color = DesignTokens.Colors.orange,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 1.2.sp,
                )
                // tsx L81 title: 15sp / 700 / text
                Text(
                    text = "いまいる場所から探す",
                    color = DesignTokens.Colors.text,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                )
                // tsx L82 description: 11sp / lineHeight 17 / textSecondary
                Text(
                    text = "位置情報は検索条件にだけ使い、許可しない場合は地図から指定できます。",
                    color = DesignTokens.Colors.textSecondary,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                )
            }
            // tsx L84-94: 選択済みのときだけ「クリア」ボタン
            if (location != null) {
                Box(
                    modifier = Modifier
                        .testTag("location-clear")
                        .clickable(role = Role.Button) {
                            // tsx L69-74 clearLocation: 選択解除 + 入力もリセット
                            locationJob?.cancel()
                            status = LocationStatus.Idle
                            errorMessage = ""
                            onLocationChange(null)
                            manualLocation = ""
                        }
                        .padding(vertical = 4.dp, horizontal = 8.dp),
                ) {
                    // tsx L92 / L212-215: 11sp / textTertiary
                    Text(
                        text = "クリア",
                        color = DesignTokens.Colors.textTertiary,
                        fontSize = 11.sp,
                    )
                }
            }
        }

        if (location != null) {
            // tsx L97-106 selectedLocation: successSoft / radius sm / padding 11 / gap 10
            Row(
                modifier = Modifier
                    .testTag("location-selected")
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(DesignTokens.Radius.sm))
                    .background(DesignTokens.Colors.successSoft)
                    .padding(11.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // tsx L290-295 selectedDot: 10dp / pill / success
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(RoundedCornerShape(DesignTokens.Radius.pill))
                        .background(DesignTokens.Colors.success),
                )
                // tsx L100-105 selectedCopy: gap 2
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    // tsx L299-303 selectedLabel: 13sp / 700 / text
                    Text(
                        text = location.label,
                        color = DesignTokens.Colors.text,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    // tsx L102-104 selectedMeta: 11sp / textSecondary
                    Text(
                        text = if (location.source == "gps") "GPSで取得した現在地付近" else "地図・入力から指定",
                        color = DesignTokens.Colors.textSecondary,
                        fontSize = 11.sp,
                    )
                }
            }
        } else {
            // tsx L109-123 actionRow（location-gps ボタン + 「または」）
            val requesting = status == LocationStatus.Requesting
            Row(
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .testTag("location-gps")
                        .defaultMinSize(minHeight = 38.dp)
                        .clip(RoundedCornerShape(DesignTokens.Radius.sm))
                        .background(DesignTokens.Colors.black)
                        .alpha(if (requesting) 0.55f else 1f)
                        .clickable(enabled = !requesting, role = Role.Button, onClick = requestGps)
                        .padding(horizontal = 15.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (requesting) "取得中…" else "◎ 現在地を使う",
                        color = DesignTokens.Colors.surface,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Text(
                    text = "または",
                    color = DesignTokens.Colors.textTertiary,
                    fontSize = 11.sp,
                )
            }

            // tsx L126-137 manualInput: minHeight 38 / paddingH 11 / border / radius sm / 13sp
            val isBlank = manualLocation.trim().isEmpty()
            BasicTextField(
                value = manualLocation,
                onValueChange = { manualLocation = it },
                modifier = Modifier
                    .testTag("location-map-input")
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(DesignTokens.Radius.sm))
                    .background(DesignTokens.Colors.surface)
                    .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.sm)),
                textStyle = TextStyle(
                    color = DesignTokens.Colors.text,
                    fontSize = 13.sp,
                ),
                cursorBrush = SolidColor(DesignTokens.Colors.text),
                singleLine = true,
                // tsx L135-136: returnKeyType="done" + onSubmitEditing で確定
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { useManualLocation() }),
                decorationBox = { innerTextField ->
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 38.dp)
                            .padding(horizontal = 11.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (manualLocation.isEmpty()) {
                            // tsx L132-133 placeholder / textTertiary
                            Text(
                                text = "例：池袋駅、渋谷",
                                color = DesignTokens.Colors.textTertiary,
                                fontSize = 13.sp,
                            )
                        }
                        innerTextField()
                    }
                },
            )

            // tsx L148-157 location-use-manual（文言 L156 逐語）。
            // tsx L270-278 manualApply: テキストリンク風（paddingVertical 4 / 11sp / 700 / orange）
            // disabled 表現 L153-154, L279-281 = 入力空で opacity 0.45
            Box(
                modifier = Modifier
                    .testTag("location-use-manual")
                    .alpha(if (isBlank) 0.45f else 1f)
                    .clickable(enabled = !isBlank, role = Role.Button) { useManualLocation() }
                    .padding(vertical = 4.dp),
            ) {
                Text(
                    text = "この場所で検索条件にする",
                    color = DesignTokens.Colors.orange,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }

        // tsx L161-169 errorText / helperText
        if (errorMessage.isNotEmpty()) {
            Text(
                text = errorMessage,
                color = DesignTokens.Colors.danger,
                fontSize = 11.sp,
                lineHeight = 17.sp,
                modifier = Modifier.testTag("location-error"),
            )
        } else {
            Text(
                text = if (status == LocationStatus.Granted) {
                    "現在地はこのセッションの検索条件に含まれます。"
                } else {
                    "GPSを拒否しても、場所名を入力して続けられます。"
                },
                color = DesignTokens.Colors.textTertiary,
                fontSize = 10.sp,
                lineHeight = 15.sp,
            )
        }
    }
}
