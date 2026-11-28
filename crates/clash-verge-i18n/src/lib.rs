use rust_i18n::i18n;
use std::borrow::Cow;
use std::sync::LazyLock;

const DEFAULT_LANGUAGE: &str = "zh";
i18n!("locales", fallback = "zh");

static SUPPORTED_LOCALES: LazyLock<Vec<Cow<'static, str>>> = LazyLock::new(|| rust_i18n::available_locales!());

#[inline]
fn locale_alias(locale: &str) -> Option<&'static str> {
    match locale {
        "ja" | "ja-jp" | "jp" => Some("jp"),
        "zh" | "zh-cn" | "zh-hans" | "zh-sg" | "zh-my" | "zh-chs" => Some("zh"),
        "zh-tw" | "zh-hk" | "zh-hant" | "zh-mo" | "zh-cht" => Some("zhtw"),
        _ => None,
    }
}

#[inline]
fn resolve_supported_language(language: &str) -> Option<Cow<'static, str>> {
    if language.is_empty() {
        return None;
    }
    let normalized = language.to_lowercase().replace('_', "-");
    let segments: Vec<&str> = normalized.split('-').collect();
    for i in (1..=segments.len()).rev() {
        let prefix = segments[..i].join("-");
        if let Some(alias) = locale_alias(&prefix)
            && let Some(found) = SUPPORTED_LOCALES.iter().find(|l| l.eq_ignore_ascii_case(alias))
        {
            return Some(found.clone());
        }
        if let Some(found) = SUPPORTED_LOCALES.iter().find(|l| l.eq_ignore_ascii_case(&prefix)) {
            return Some(found.clone());
        }
    }
    None
}

#[inline]
pub fn current_language(language: Option<&str>) -> Cow<'static, str> {
    language
        .filter(|lang| !lang.is_empty())
        .and_then(resolve_supported_language)
        .unwrap_or_else(system_language)
}

#[inline]
pub fn system_language() -> Cow<'static, str> {
    sys_locale::get_locale()
        .as_deref()
        .and_then(resolve_supported_language)
        .unwrap_or(Cow::Borrowed(DEFAULT_LANGUAGE))
}

#[inline]
pub fn sync_locale(language: Option<&str>) {
    rust_i18n::set_locale(&current_language(language));
}

#[inline]
pub fn set_locale(language: &str) {
    let lang = resolve_supported_language(language).unwrap_or(Cow::Borrowed(DEFAULT_LANGUAGE));
    rust_i18n::set_locale(&lang);
}

#[inline]
pub fn translate(key: &str) -> Cow<'_, str> {
    rust_i18n::t!(key)
}

#[doc(hidden)]
pub fn format_placeholders(template: &str, pairs: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 1..];
        if let Some(end) = after_open.find('}') {
            let key = &after_open[..end];
            if let Some((_, val)) = pairs.iter().find(|(k, _)| *k == key) {
                out.push_str(val);
            } else {
                out.push('{');
                out.push_str(key);
                out.push('}');
            }
            rest = &after_open[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::translate(&$key)
    };
    ($key:expr, $($arg_name:ident = $arg_value:expr),*) => {
        {
            let _template = $crate::translate(&$key);
            let _pairs: &[(&str, &str)] = &[
                $((stringify!($arg_name), &$arg_value),)*
            ];
            ::std::borrow::Cow::<'static, str>::Owned($crate::format_placeholders(&_template, _pairs))
        }
    };
}
