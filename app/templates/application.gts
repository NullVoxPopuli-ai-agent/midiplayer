// Side-effect: pulls in nvp.ui's design tokens (variables.css / focus.css)
import "nvp.ui/button";
import "./application.css";

import { PortalTargets } from "ember-primitives";
import { Header, Shell, ThemeToggle } from "nvp.ui";

import { FileMenu } from "#components/file-menu.gts";

<template>
  <Shell>
    <PortalTargets />
    <Header>
      <:left>
        <span class="header-left">
          <strong>MIDI Player</strong>
          <FileMenu />
        </span>
      </:left>
      <:right><ThemeToggle /></:right>
    </Header>

    <main class="app-main">
      {{outlet}}
    </main>
  </Shell>
</template>
