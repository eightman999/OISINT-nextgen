package com.oisint.android

import android.app.Application
import com.oisint.android.di.AppContainer

class OisintApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
