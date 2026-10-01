package com.oisint.android.testing

import com.oisint.android.R
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * JVM 単体テスト用の string resource 読み出し（Robolectric 無し）。
 *
 * ViewModel / Format は表示文言を `@StringRes` ID で返すため、Web 正典（日本語逐語）との
 * 照合は `res/values/strings.xml`（既定ロケール = 日本語）を実ファイルで読んで行う。
 */
object StringResources {
    private val moduleDir: File by lazy {
        val propRoot = System.getProperty("oisint.repo.root")
        val candidates = listOfNotNull(
            propRoot?.let { File(it, "android/app") },
            File(System.getProperty("user.dir")),
            File(System.getProperty("user.dir"), "app"),
        )
        candidates.firstOrNull { File(it, "src/main/res/values/strings.xml").isFile }
            ?: error("src/main/res/values/strings.xml が見つかりません")
    }

    private fun load(qualifier: String): Map<String, String> {
        val file = File(moduleDir, "src/main/res/$qualifier/strings.xml")
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val el = nodes.item(i) as Element
            el.getAttribute("name") to unescape(el.textContent)
        }
    }

    private fun unescape(raw: String): String =
        raw.replace("\\n", "\n").replace("\\'", "'").replace("\\\"", "\"").replace("\\@", "@").replace("\\?", "?")

    private val ja: Map<String, String> by lazy { load("values") }
    private val en: Map<String, String> by lazy { load("values-en") }

    /** R.string の ID から resource 名を引く（R クラスの static field を走査）。 */
    fun nameOf(id: Int): String =
        R.string::class.java.fields.firstOrNull { it.getInt(null) == id }?.name
            ?: error("R.string に ID $id がありません")

    fun ja(id: Int): String = ja[nameOf(id)] ?: error("values/strings.xml に ${nameOf(id)} がありません")

    fun en(id: Int): String = en[nameOf(id)] ?: error("values-en/strings.xml に ${nameOf(id)} がありません")

    fun jaNames(): Set<String> = ja.keys

    fun enNames(): Set<String> = en.keys
}
