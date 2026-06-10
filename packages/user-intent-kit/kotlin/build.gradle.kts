// SPDX-License-Identifier: AGPL-3.0

plugins {
    kotlin("jvm") version "1.9.22"
}

group = "com.thinkoff"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
}

kotlin {
    jvmToolchain(17)
}
