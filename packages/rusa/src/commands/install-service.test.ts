import { describe, expect, it } from "vitest";
import {
  buildAlertUnit,
  buildQuotaCoordinatorUnit,
  buildServiceUnit,
  quotaCoordinatorUnitNames,
} from "./install-service.js";

const base = {
  description: "Rusa",
  mcHome: "/home/x/.rusa",
  cliPath: "/deploy/rusa-prod/packages/rusa/dist/cli.js",
  nodePath: "/usr/bin/node",
  userPath: "/usr/bin:/bin",
};

describe("buildServiceUnit — self-update systemd policy ", () => {
  it("orchestrator unit: Restart=always + StartLimit + OnFailure + ExecStartPre", () => {
    const unit = buildServiceUnit({
      ...base,
      restart: "always",
      startLimit: { intervalSec: 300, burst: 5 },
      onFailureUnit: "rusa-alert.service",
      execStartPre: '"/usr/bin/node" "/deploy/.../verify-build.mjs" "/deploy/rusa-prod"',
    });
    expect(unit).toContain("Restart=always"); // clean exit(0) → systemd restarts
    expect(unit).not.toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("OnFailure=rusa-alert.service");
    expect(unit).toContain("ExecStartPre=");
    expect(unit).toContain("verify-build.mjs");
    // StartLimit + OnFailure belong in [Unit], before [Service].
    expect(unit.indexOf("StartLimitBurst")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit.indexOf("OnFailure=")).toBeLessThan(unit.indexOf("[Service]"));
    // ExecStartPre runs before ExecStart.
    expect(unit.indexOf("ExecStartPre=")).toBeLessThan(unit.indexOf("ExecStart="));
  });

  it("defaults to on-failure with no extra directives (package mode / forwarder)", () => {
    const unit = buildServiceUnit(base);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("StartLimitBurst");
    expect(unit).not.toContain("OnFailure=");
    expect(unit).not.toContain("ExecStartPre=");
  });

  it("logs to an append-to-file sink by default, or the journal when opted in", () => {
    expect(buildServiceUnit(base)).toContain("StandardOutput=append:");
    const journal = buildServiceUnit({ ...base, logToJournal: true });
    expect(journal).toContain("StandardOutput=journal");
    expect(journal).toContain("StandardError=journal");
    expect(journal).not.toContain("append:");
  });
});

describe("buildAlertUnit — OnFailure oneshot (build-independent notifier)", () => {
  it("is a oneshot that runs the standalone notifier with env wired", () => {
    const unit = buildAlertUnit({
      description: "Rusa failure alert",
      nodePath: "/usr/bin/node",
      notifyScript: "/deploy/rusa-prod/packages/rusa/scripts/notify-failure.mjs",
      mcHome: "/home/x/.rusa",
      errorChat: "spaces/AAAA",
      gchatConfigDir: "/home/x/.config/gchat",
      message: "rusa.service entered a failed state",
    });
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("notify-failure.mjs");
    expect(unit).toContain("Environment=RUSA_ERROR_CHAT=spaces/AAAA");
    expect(unit).toContain("Environment=GCHAT_CONFIG_DIR=/home/x/.config/gchat");
    expect(unit).toContain("Environment=RUSA_HOME=/home/x/.rusa");
    expect(unit).toContain('ExecStart="/usr/bin/node"');
  });

  it("omits the chat env lines when unconfigured (journal+marker still fire)", () => {
    const unit = buildAlertUnit({
      description: "alert",
      nodePath: "/usr/bin/node",
      notifyScript: "/x/notify-failure.mjs",
      mcHome: "/home/x/.rusa",
      message: "failed",
    });
    expect(unit).not.toContain("RUSA_ERROR_CHAT");
    expect(unit).not.toContain("GCHAT_CONFIG_DIR");
  });
});

describe("buildServiceUnit — coordinator ordering", () => {
  it("orders after the coordinator without depending on it", () => {
    const unit = buildServiceUnit({
      ...base,
      coordinatorUnit: "rusa-quota-coordinator.service",
    });
    expect(unit).toContain("After=rusa-quota-coordinator.service");
    expect(unit).toContain("Wants=rusa-quota-coordinator.service");
    // An instance whose coordinator is down paces on its last applied interval;
    // Requires= would turn that degradation into an orchestrator outage.
    expect(unit).not.toContain("Requires=");
    expect(unit.indexOf("Wants=rusa-quota-coordinator.service")).toBeLessThan(
      unit.indexOf("[Service]")
    );
  });

  it("omits the ordering entirely when no coordinator is installed", () => {
    expect(buildServiceUnit(base)).not.toContain("quota-coordinator");
  });
});

describe("quotaCoordinatorUnitNames", () => {
  it("derives both names from the instance basename, so staging cannot collide", () => {
    expect(quotaCoordinatorUnitNames("rusa")).toEqual({
      serviceUnit: "rusa-quota-coordinator.service",
      alertUnit: "rusa-quota-coordinator-alert.service",
    });
    expect(quotaCoordinatorUnitNames("rusa-staging").serviceUnit).toBe(
      "rusa-staging-quota-coordinator.service"
    );
  });
});

describe("buildQuotaCoordinatorUnit — the probe environment", () => {
  const coordinatorBase = { ...base, xdgRuntimeDir: "/run/user/1000" };

  it("runs the coordinator against the instance home", () => {
    const unit = buildQuotaCoordinatorUnit(coordinatorBase);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/deploy/rusa-prod/packages/rusa/dist/cli.js"' +
        ' "quota-coordinator" "--home" "/home/x/.rusa"'
    );
    expect(unit).toContain("WorkingDirectory=/home/x/.rusa");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("carries the environment a probe needs, not systemd's default", () => {
    const unit = buildQuotaCoordinatorUnit(coordinatorBase);
    // The provider CLIs, bwrap and tmux all live on the user PATH; systemd's
    // default PATH would start a service that answers healthz and never scrapes.
    expect(unit).toContain("Environment=PATH=/usr/bin:/bin");
    // Set explicitly: a coordinator that falls back to /tmp for its socket is
    // one its clients cannot find.
    expect(unit).toContain("Environment=XDG_RUNTIME_DIR=/run/user/1000");
    expect(unit).toContain("Environment=RUSA_HOME=/home/x/.rusa");
    expect(unit).toContain("EnvironmentFile=-/home/x/.rusa/.env");
  });

  it("logs at the level the metric series are emitted at, in JSON, to the journal", () => {
    const unit = buildQuotaCoordinatorUnit(coordinatorBase);
    expect(unit).toContain("Environment=RUSA_LOG_LEVEL=debug");
    expect(unit).toContain("Environment=RUSA_LOG_FORMAT=json");
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
    expect(unit).not.toContain("append:");
  });

  it("restarts on failure only, because a clean exit here is a requested stop", () => {
    const unit = buildQuotaCoordinatorUnit(coordinatorBase);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("Restart=always");
    expect(unit).toContain("RestartSec=10");
  });

  it("gives up on a crash loop and fires its own alert companion", () => {
    const unit = buildQuotaCoordinatorUnit({
      ...coordinatorBase,
      startLimit: { intervalSec: 300, burst: 5 },
      onFailureUnit: "rusa-quota-coordinator-alert.service",
    });
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("OnFailure=rusa-quota-coordinator-alert.service");
    expect(unit.indexOf("StartLimitBurst")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit.indexOf("OnFailure=")).toBeLessThan(unit.indexOf("[Service]"));
  });
});
