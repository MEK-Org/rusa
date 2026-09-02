const fs = require("fs");
const lines = fs
  .readFileSync("packages/rusa/flutter_dashboard/lib/widgets/obligation_dialogs.dart", "utf8")
  .split("\n");

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("if (dialogContext.mounted)")) {
    if (lines[i + 1].includes("Navigator.of(dialogContext).pop();")) {
      lines[i] = lines[i] + " {";
      lines[i + 1] = lines[i + 1] + " }";
    }
  }
}

fs.writeFileSync(
  "packages/rusa/flutter_dashboard/lib/widgets/obligation_dialogs.dart",
  lines.join("\n")
);
