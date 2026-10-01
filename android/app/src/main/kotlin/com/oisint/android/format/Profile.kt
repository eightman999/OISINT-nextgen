package com.oisint.android.format

import com.oisint.android.model.LocationSelection
import com.oisint.android.model.TasteProfile

/** query 合成ヘルパー。正典は `src/lib/profile.ts` L41-64（1:1 移植）。 */
object Profile {

    /** profile.ts L41-49: アレルギーと健康目的は raw_query / 共有調査へ渡さない */
    fun tasteProfileToQuery(profile: TasteProfile): String? {
        val parts = mutableListOf<String>()
        if (profile.likes.isNotEmpty()) parts.add("好き: ${profile.likes.joinToString("、")}")
        if (profile.avoid.isNotEmpty()) parts.add("避けたい: ${profile.avoid.joinToString("、")}")
        return if (parts.isNotEmpty()) parts.joinToString(" / ") else null
    }

    /** profile.ts L51-64: 座標は raw_query へ到達させない */
    fun locationToQuery(location: LocationSelection?): String? {
        if (location == null) return null
        if (location.source == "gps" && location.latitude != null && location.longitude != null) {
            return "場所: 現在地付近"
        }
        return "場所: ${location.label}"
    }
}
