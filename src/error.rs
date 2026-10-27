//! One error type for every command. The frontend only ever sees a message string, never a
//! backtrace or an OS error structure.

use std::fmt;

#[derive(Debug)]
pub struct AppError(pub String);

pub type AppResult<T> = Result<T, AppError>;

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError(format!("JSON: {error}"))
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError(message.to_string())
    }
}

/// `bail!("...")` returns an `AppError` from the current function.
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::AppError(format!($($arg)*)))
    };
}
