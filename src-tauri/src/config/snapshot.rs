use crate::utils::dirs;
use anyhow::{Context as _, Result, bail};
use std::{io::ErrorKind, path::PathBuf};

pub(crate) struct FileSnapshot {
    pub(crate) path: PathBuf,
    content: Option<Vec<u8>>,
}

async fn capture_files(paths: &[PathBuf]) -> Result<Vec<FileSnapshot>> {
    let mut snapshots = Vec::with_capacity(paths.len());
    for path in paths {
        let content = match tokio::fs::read(path).await {
            Ok(content) => Some(content),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("failed to snapshot {}", path.display()));
            }
        };
        snapshots.push(FileSnapshot {
            path: path.clone(),
            content,
        });
    }
    Ok(snapshots)
}

pub(crate) async fn capture_config_files() -> Result<Vec<FileSnapshot>> {
    let runtime_path = dirs::app_home_dir()?.join(crate::constants::files::RUNTIME_CONFIG);
    capture_files(&[dirs::clash_path()?, dirs::verge_path()?, runtime_path]).await
}

async fn write_bytes_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt as _;
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), nanoid::nanoid!()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    if let Err(err) = file.write_all(content).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(err);
    }
    if let Err(err) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(err);
    }
    drop(file);
    if let Err(err) = tokio::fs::rename(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(err);
    }
    Ok(())
}

pub(crate) async fn restore_files(snapshots: &[FileSnapshot]) -> Result<()> {
    let mut errors = Vec::new();
    for snapshot in snapshots {
        let result = match &snapshot.content {
            Some(content) => write_bytes_atomic(&snapshot.path, content).await,
            None => match tokio::fs::remove_file(&snapshot.path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            },
        };
        if let Err(error) = result {
            errors.push(format!("{}: {}", snapshot.path.display(), error));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        bail!("{}", errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::{capture_files, restore_files};

    #[tokio::test]
    async fn restores_every_configuration_layer_after_partial_write() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "config-rollback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&root).await?;
        let paths = [
            root.join("config.yaml"),
            root.join("verge.yaml"),
            root.join("clash-verge.yaml"),
        ];
        for (index, path) in paths.iter().enumerate() {
            tokio::fs::write(path, format!("original-{index}")).await?;
        }

        let snapshots = capture_files(&paths).await?;
        tokio::fs::write(&paths[0], "changed").await?;
        tokio::fs::write(&paths[1], "changed").await?;
        tokio::fs::remove_file(&paths[2]).await?;
        restore_files(&snapshots).await?;

        for (index, path) in paths.iter().enumerate() {
            assert_eq!(tokio::fs::read_to_string(path).await?, format!("original-{index}"));
        }
        tokio::fs::remove_dir_all(root).await?;
        Ok(())
    }
}
