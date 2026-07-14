# reliable-shop-management

A minimal TypeScript-based installable app package.

## Prerequisites

- Node.js 18+
- npm

## Build

```bash
npm install
npm run build
```

## Run locally

```bash
npm start
```

## Build installable package

```bash
npm pack
```

This creates a `.tgz` package in the project root.

## Phase 3 validation

The repository includes a Phase 3 test stack under `tests/` for CLI baseline checks, security checks, and package smoke validation.

Run the full baseline locally with:

```bash
npm run build
npm run phase3:baseline
npm run phase3:package-smoke
```

Generated reports are written under `tests/` and are ignored by Git.

## Install the app

From the generated package file:

```bash
npm install -g ./reliable-shop-management-1.0.0.tgz
reliable-shop
```
