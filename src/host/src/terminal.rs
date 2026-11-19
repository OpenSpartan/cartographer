use std::fmt::Write;
use std::io::IsTerminal;

use console::Style;

pub fn panel(title: &str, status: &str, fields: &[(&str, &str)], action: (&str, &str), notes: &[&str]) -> String {
    let color = std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none()
        && console::colors_enabled();
    render(title, status, fields, action, notes, color)
}

fn render(title: &str, status: &str, fields: &[(&str, &str)], action: (&str, &str), notes: &[&str], color: bool) -> String {
    let accent = Style::new().cyan().bold().force_styling(color);
    let strong = Style::new().bold().force_styling(color);
    let muted = Style::new().dim().force_styling(color);
    let success = Style::new().green().bold().force_styling(color);
    let width = fields.iter().map(|(label, _)| label.len()).fold("Status".len(), usize::max);
    let mut output = format!(
        "\n  {} {}  {}\n\n  {}\n",
        muted.apply_to("OpenSpartan"), accent.apply_to("Cartographer"),
        muted.apply_to(cartographer::VERSION), strong.apply_to(title),
    );
    writeln!(output, "    {}  {}", muted.apply_to(format!("{:<width$}", "Status")), success.apply_to(status)).unwrap();
    for (label, value) in fields {
        writeln!(output, "    {}  {value}", muted.apply_to(format!("{label:<width$}"))).unwrap();
    }
    write!(output, "\n  {}\n    {}\n\n", accent.apply_to(action.0), strong.apply_to(action.1)).unwrap();
    for note in notes {
        writeln!(output, "  {}", muted.apply_to(note)).unwrap();
    }
    output.push('\n');
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn styling_preserves_the_plain_text_and_copyable_action() {
        let action = ("Next step: start the viewer", r".\cartographer.exe 17292 serve --lan");
        let fields = [("PID", "17292"), ("Console", "Separate window")];
        let notes = ["Run this in the same terminal."];
        let plain = render("Dedicated server", "Started", &fields, action, &notes, false);
        let styled = render("Dedicated server", "Started", &fields, action, &notes, true);
        assert!(!plain.contains('\u{1b}'));
        assert!(styled.contains('\u{1b}'));
        assert_eq!(console::strip_ansi_codes(&styled), plain);
        assert!(plain.contains("OpenSpartan Cartographer"));
        assert!(plain.contains("Status   Started"));
        assert!(plain.contains("Next step: start the viewer\n    .\\cartographer.exe 17292 serve --lan\n\n"));
        assert!(!plain.contains(';'));
    }

    #[test]
    fn viewer_panel_keeps_the_url_distinct_from_its_metadata() {
        let panel = render("Viewer", "Ready", &[("Access", "Local network"), ("Browser", "Opening default browser")],
            ("Open viewer", "http://192.168.1.23:17843/"), &["Ctrl+C stops the viewer. The Halo server keeps running."], false);
        assert!(panel.contains("Status   Ready"));
        assert!(panel.contains("Access   Local network"));
        assert!(panel.contains("Browser  Opening default browser"));
        assert!(panel.contains("Open viewer\n    http://192.168.1.23:17843/\n\n"));
        assert!(!panel.contains(';'));
    }

    #[test]
    fn status_and_details_align_to_the_longest_label() {
        let panel = render("Dedicated server", "Started", &[("PID", "17292"), ("Console type", "Separate window")],
            ("Next step", "cartographer serve"), &[], false);
        let column = |value: &str| panel.lines().find_map(|line| line.find(value)).unwrap();
        assert_eq!(column("Started"), column("17292"));
        assert_eq!(column("Started"), column("Separate window"));
    }
}