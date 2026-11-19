//! TypeScript to JavaScript for films-ui, the UI framework Cartographer shares with OpenSpartan
//! Films, with oxc: the types are stripped and nothing else changes (films-ui uses no enums or
//! namespaces), so the browser runs the files as written and neither building nor serving
//! Cartographer needs Node. build.rs embeds the converted files, and the dev server converts them
//! from disk on each request.

use std::path::Path;

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};

/// `source`, the TypeScript file at `path`, as an ES module.
pub fn to_javascript(path: &Path, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() { return Err(format!("{}: {error}", path.display())); }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    let transformed = Transformer::new(&allocator, path, &TransformOptions::default()).build_with_scoping(scoping, &mut program);
    if let Some(error) = transformed.diagnostics.first() { return Err(format!("{}: {error}", path.display())); }
    Ok(Codegen::new().build(&program).code)
}
