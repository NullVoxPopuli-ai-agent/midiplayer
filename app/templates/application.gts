// Side-effect: pulls in nvp.ui's design tokens (variables.css / focus.css)
import "nvp.ui/button";
import "./application.css";

import { Header, Shell, ThemeToggle } from "nvp.ui";

<template>
  <Shell>
    <Header>
      <:left><strong>MIDI Player</strong></:left>
      <:right><ThemeToggle /></:right>
    </Header>

    <main class="app-main">
      {{outlet}}
    </main>
  </Shell>
</template>
