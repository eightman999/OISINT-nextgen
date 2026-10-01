package com.oisint.android.ui.home

import androidx.annotation.StringRes
import com.oisint.android.R

/**
 * index.tsx L35 FILTER_CHIPS。
 *
 * [wireValue] は調査クエリへそのまま連結してサーバへ送る値（日本語固定・翻訳しない）。
 * [labelRes] は画面表示用のローカライズ済みラベル。
 */
data class FilterChip(val wireValue: String, @StringRes val labelRes: Int)

val FILTER_CHIPS = listOf(
    FilterChip("禁煙", R.string.filter_chip_non_smoking),
    FilterChip("個室", R.string.filter_chip_private_room),
    FilterChip("カード可", R.string.filter_chip_card_ok),
    FilterChip("徒歩5分以内", R.string.filter_chip_walk_5min),
    FilterChip("Wi-Fi", R.string.filter_chip_wifi),
    FilterChip("静か", R.string.filter_chip_quiet),
    FilterChip("子連れOK", R.string.filter_chip_kids_ok),
)

/** サーバへ送る chip 値から表示ラベルを引く。未知の値は null（呼び出し側で原文表示）。 */
@StringRes
fun filterChipLabelRes(wireValue: String): Int? =
    FILTER_CHIPS.firstOrNull { it.wireValue == wireValue }?.labelRes
