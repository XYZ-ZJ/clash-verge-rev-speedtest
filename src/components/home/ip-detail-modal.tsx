import {
  CancelRounded,
  CheckCircleRounded,
  CloseOutlined,
  LanguageOutlined,
  RefreshOutlined,
  VisibilityOffOutlined,
  VisibilityOutlined,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Skeleton,
  type Theme,
  Typography,
} from '@mui/material'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type EgressItem,
  type EgressReport,
  type FindingItem,
  type IpScoreSource,
  detectCloudflareStatus,
  fetchIpPurityScores,
  runFullEgressDetection,
} from '@/services/egress'
import getSystem from '@/utils/get-system'

interface Props {
  open: boolean
  onClose: () => void
}

const getCountryFlag = (countryCode: string | undefined) => {
  if (!countryCode) return ''
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

export const IpDetailModal = memo(({ open, onClose }: Props) => {
  const { t } = useTranslation()
  const [report, setReport] = useState<EgressReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [detectFailed, setDetectFailed] = useState(false)
  const [cfLoading, setCfLoading] = useState(false)
  const [hideIp, setHideIp] = useState(false)
  const [ipScores, setIpScores] = useState<IpScoreSource[]>([])
  const [scoresLoading, setScoresLoading] = useState(false)
  const lastScoredIpRef = useRef<string | null>(null)
  const scoreRequestIdRef = useRef(0)

  const targetScoreExit =
    report?.exits.find((e) => e.isProxy) || report?.exits[0] || null

  const handleRefreshScores = useCallback(
    async (ipOverride?: string) => {
      const targetIp = ipOverride || targetScoreExit?.ip
      if (!targetIp) return
      const reqId = ++scoreRequestIdRef.current
      lastScoredIpRef.current = targetIp
      setScoresLoading(true)
      try {
        const res = await fetchIpPurityScores(targetIp)
        if (scoreRequestIdRef.current === reqId) {
          setIpScores(res)
        }
      } catch (err) {
        console.error('[IpDetailModal] fetchIpPurityScores failed:', err)
      } finally {
        if (scoreRequestIdRef.current === reqId) {
          setScoresLoading(false)
        }
      }
    },
    [targetScoreExit?.ip],
  )

  // 全量真实网络探测（并发测试所有出口、分流、WebRTC、时区与 Cloudflare）
  const handleDetect = useCallback(async () => {
    setLoading(true)
    setDetectFailed(false)
    try {
      const res = await runFullEgressDetection()
      lastScoredIpRef.current = null
      setReport(res)
    } catch (err) {
      console.error('[IpDetailModal] egress detection failed:', err)
      setDetectFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  // 独立实测 Cloudflare 人机验证与节点放行状态
  const handleRetestCf = useCallback(async () => {
    setCfLoading(true)
    try {
      const cfStatus = await detectCloudflareStatus()
      setReport((prev) => (prev ? { ...prev, cfStatus } : prev))
    } finally {
      setCfLoading(false)
    }
  }, [])

  // 弹窗打开且未有数据时，自动触发首次真实探测
  useEffect(() => {
    if (open && !report && !loading && !detectFailed) {
      handleDetect()
    }
  }, [open, report, loading, detectFailed, handleDetect])

  // 默认查询：拿到出口 IP 后自动查询多源 IP 纯净度评分
  useEffect(() => {
    const ip = targetScoreExit?.ip
    if (open && ip && !loading && lastScoredIpRef.current !== ip) {
      handleRefreshScores(ip)
    }
  }, [open, targetScoreExit?.ip, loading, handleRefreshScores])

  const cfState = report?.cfStatus.state || 'fail'
  const isCfPass = cfState === 'pass'
  const isCfWarn = cfState === 'interactive'
  const cfHintText =
    cfState === 'pass'
      ? 'Cloudflare 边缘节点实测直接放行，该出口信誉良好。'
      : cfState === 'interactive'
        ? '检测到可能会触发 Cloudflare 质询，访问受保护站点时可能需要完成人机验证。'
        : 'Cloudflare 边缘探测未通过或连接受阻，建议检查当前节点连通性或切换节点后重试。'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            borderRadius: 3,
            backgroundImage: 'none',
            boxShadow: (theme: Theme) =>
              theme.palette.mode === 'dark'
                ? '0 12px 40px rgba(0, 0, 0, 0.6)'
                : '0 12px 40px rgba(0, 0, 0, 0.12)',
          },
        },
      }}
    >
      <DialogTitle
        sx={{
          py: 2,
          px: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2 }}>
          <LanguageOutlined sx={{ color: 'primary.main', fontSize: 24 }} />
          <Typography
            variant="h6"
            sx={{ fontWeight: 600, fontSize: '1.05rem' }}
          >
            {t('home.components.ipInfo.detailModal.title')}
          </Typography>
          {report?.timestamp && !loading && (
            <Box
              sx={{
                display: { xs: 'none', sm: 'flex' },
                alignItems: 'center',
                gap: 1,
                ml: 1,
              }}
            >
              <Typography variant="caption" color="text.secondary">
                {t('home.components.ipInfo.detailModal.lastCheck')}:{' '}
                {new Date(report.timestamp).toLocaleTimeString()}
              </Typography>
            </Box>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={handleDetect}
            disabled={loading}
            startIcon={
              loading ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <RefreshOutlined fontSize="small" />
              )
            }
            sx={{ textTransform: 'none', borderRadius: 1.5 }}
          >
            {loading
              ? t('home.components.ipInfo.detailModal.testing')
              : t('home.components.ipInfo.detailModal.refresh')}
          </Button>
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ color: 'text.secondary' }}
          >
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: { xs: 2, sm: 3 } }}>
        {/* 模块一：实测 CLOUDFLARE 人机验证 */}
        <Box sx={{ mb: 3 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 700,
              fontSize: '0.85rem',
              color: 'text.secondary',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              mb: 1.2,
            }}
          >
            {t('home.components.ipInfo.detailModal.cfTitle')}
          </Typography>

          <Box
            sx={{
              p: 2,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              borderLeft: '4px solid',
              borderLeftColor: isCfPass
                ? 'success.main'
                : isCfWarn
                  ? 'warning.main'
                  : 'error.main',
              bgcolor: (theme: Theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.03)'
                  : 'rgba(0, 0, 0, 0.02)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 2,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1.5,
                flex: 1,
              }}
            >
              {loading && !report ? (
                <Skeleton variant="circular" width={26} height={26} />
              ) : isCfPass ? (
                <CheckCircleRounded
                  sx={{ color: 'success.main', fontSize: 26, mt: 0.2 }}
                />
              ) : isCfWarn ? (
                <WarningAmberRounded
                  sx={{ color: 'warning.main', fontSize: 26, mt: 0.2 }}
                />
              ) : (
                <CancelRounded
                  sx={{ color: 'error.main', fontSize: 26, mt: 0.2 }}
                />
              )}

              <Box sx={{ flex: 1 }}>
                {loading && !report ? (
                  <>
                    <Skeleton variant="text" width={120} height={26} />
                    <Skeleton variant="text" width="85%" height={20} />
                  </>
                ) : (
                  <>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography
                        variant="subtitle1"
                        sx={{
                          fontWeight: 700,
                          color: isCfPass
                            ? 'success.main'
                            : isCfWarn
                              ? 'warning.main'
                              : 'error.main',
                          lineHeight: 1.3,
                        }}
                      >
                        {report?.cfStatus.title || '直接通过'}
                      </Typography>
                      {report?.cfStatus.rttMs ? (
                        <Chip
                          size="small"
                          label={`${report.cfStatus.rttMs} ms`}
                          variant="outlined"
                          sx={{
                            height: 20,
                            fontSize: '0.68rem',
                            fontWeight: 600,
                          }}
                        />
                      ) : null}
                    </Box>
                    <Typography
                      variant="body2"
                      color="text.primary"
                      sx={{ mt: 0.5, lineHeight: 1.5 }}
                    >
                      {report?.cfStatus.description ||
                        '暂无有效的 Cloudflare 探测结果。'}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.3 }}
                    >
                      {cfHintText}
                    </Typography>
                  </>
                )}
              </Box>
            </Box>

            <Button
              variant="outlined"
              size="small"
              onClick={handleRetestCf}
              disabled={cfLoading || loading}
              startIcon={
                cfLoading ? (
                  <CircularProgress size={14} color="inherit" />
                ) : null
              }
              sx={{
                textTransform: 'none',
                borderRadius: 1.5,
                borderColor: 'divider',
                color: 'text.primary',
                px: 2,
                '&:hover': {
                  borderColor: 'primary.main',
                },
              }}
            >
              {cfLoading
                ? t('home.components.ipInfo.detailModal.testing')
                : t('home.components.ipInfo.detailModal.retest')}
            </Button>
          </Box>
        </Box>

        {/* 模块二：分流透视 */}
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 1.5,
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 700, fontSize: '0.98rem' }}
              >
                {report?.title || '分流透视'}
              </Typography>
              {report?.isSplit && (
                <Chip
                  size="small"
                  label="分流生效"
                  color="success"
                  variant="outlined"
                  sx={{ height: 22, fontSize: '0.72rem', fontWeight: 600 }}
                />
              )}
            </Box>
          </Box>

          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', md: 'row' },
              gap: 2.5,
              opacity: loading ? 0.5 : 1,
              transition: 'opacity 0.25s ease-in-out',
            }}
          >
            {/* 左栏：你的出口 */}
            <Box sx={{ flex: { xs: '1 1 100%', md: '0 0 44%' }, minWidth: 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mb: 1,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      letterSpacing: 0.5,
                    }}
                  >
                    {t('home.components.ipInfo.detailModal.exitsTitle')}
                  </Typography>
                  {loading && <CircularProgress size={12} color="inherit" />}
                </Box>
                <Button
                  size="small"
                  onClick={() => setHideIp(!hideIp)}
                  startIcon={
                    hideIp ? (
                      <VisibilityOutlined fontSize="inherit" />
                    ) : (
                      <VisibilityOffOutlined fontSize="inherit" />
                    )
                  }
                  sx={{
                    p: 0,
                    minWidth: 'auto',
                    fontSize: '0.72rem',
                    color: 'text.secondary',
                    textTransform: 'none',
                  }}
                >
                  {hideIp
                    ? t('home.components.ipInfo.detailModal.showIp')
                    : t('home.components.ipInfo.detailModal.hideIp')}
                </Button>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
                {loading && !report ? (
                  EXIT_SKELETON_KEYS.map((key) => (
                    <Skeleton
                      key={key}
                      variant="rounded"
                      height={68}
                      sx={{ borderRadius: 2 }}
                    />
                  ))
                ) : report?.exits && report.exits.length > 0 ? (
                  report.exits.map((item) => (
                    <ExitCard key={item.id} item={item} hideIp={hideIp} />
                  ))
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    未检测到出口
                  </Typography>
                )}
              </Box>

              {/* 左下角：多源 IP 纯净度评分 */}
              {(targetScoreExit || (loading && !report)) && (
                <Box sx={{ mt: 2 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      mb: 1,
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.8,
                        minWidth: 0,
                      }}
                    >
                      <Typography
                        variant="caption"
                        sx={{
                          fontWeight: 700,
                          color: 'text.secondary',
                          letterSpacing: 0.5,
                        }}
                      >
                        {t('home.components.ipInfo.detailModal.purityTitle')}
                      </Typography>
                      {targetScoreExit && (
                        <Chip
                          size="small"
                          label={targetScoreExit.id}
                          variant="outlined"
                          color={
                            targetScoreExit.isProxy ? 'primary' : 'success'
                          }
                          sx={{
                            height: 18,
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            '& .MuiChip-label': { px: 0.6 },
                          }}
                        />
                      )}
                      {scoresLoading && (
                        <CircularProgress size={12} color="inherit" />
                      )}
                    </Box>

                    <Button
                      size="small"
                      onClick={() => handleRefreshScores()}
                      disabled={scoresLoading || loading || !targetScoreExit}
                      startIcon={<RefreshOutlined fontSize="inherit" />}
                      sx={{
                        p: 0,
                        minWidth: 'auto',
                        fontSize: '0.72rem',
                        color: 'text.secondary',
                        textTransform: 'none',
                        '&:hover': {
                          color: 'primary.main',
                          bgcolor: 'transparent',
                        },
                      }}
                    >
                      {scoresLoading
                        ? t(
                            'home.components.ipInfo.detailModal.purityRefreshing',
                          )
                        : t('home.components.ipInfo.detailModal.purityRefresh')}
                    </Button>
                  </Box>

                  <Box
                    sx={{
                      p: 1.4,
                      borderRadius: 2,
                      border: 1,
                      borderColor: 'divider',
                      bgcolor: (theme: Theme) =>
                        theme.palette.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.02)'
                          : 'rgba(0, 0, 0, 0.01)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1.5,
                      opacity:
                        (loading || scoresLoading) && ipScores.length > 0
                          ? 0.65
                          : 1,
                      transition: 'opacity 0.2s ease-in-out',
                    }}
                  >
                    {(loading && !report) ||
                    (scoresLoading && ipScores.length === 0) ? (
                      SCORE_SKELETON_KEYS.map((key) => (
                        <Box key={key}>
                          <Skeleton variant="text" width={88} height={18} />
                          <Skeleton
                            variant="rounded"
                            height={34}
                            sx={{ borderRadius: 1.5, mt: 0.5 }}
                          />
                        </Box>
                      ))
                    ) : ipScores.length > 0 ? (
                      ipScores.map((item, idx) => (
                        <IpScoreBarRow
                          key={item.id}
                          item={item}
                          isLast={idx === ipScores.length - 1}
                        />
                      ))
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {t(
                          'home.components.ipInfo.detailModal.purityUnavailable',
                        )}
                      </Typography>
                    )}
                  </Box>
                </Box>
              )}
            </Box>

            {/* 右栏：检测结论 */}
            <Box sx={{ flex: { xs: '1 1 100%', md: '1 1 56%' }, minWidth: 0 }}>
              <Box sx={{ mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      letterSpacing: 0.5,
                    }}
                  >
                    {t('home.components.ipInfo.detailModal.findingsTitle')}
                  </Typography>
                  {loading && <CircularProgress size={12} color="inherit" />}
                </Box>
              </Box>

              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: (theme: Theme) =>
                    theme.palette.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.02)'
                      : 'rgba(0, 0, 0, 0.01)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.2,
                }}
              >
                {loading && !report ? (
                  FINDING_SKELETON_KEYS.map((key) => (
                    <Skeleton key={key} variant="text" height={32} />
                  ))
                ) : report?.findings && report.findings.length > 0 ? (
                  report.findings.map((item, idx) => (
                    <FindingRow
                      key={item.key}
                      item={item}
                      isLast={idx === report.findings.length - 1}
                    />
                  ))
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    无结论
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  )
})

const EXIT_SKELETON_KEYS = [
  'exit-skel-0',
  'exit-skel-1',
  'exit-skel-2',
] as const
const SCORE_SKELETON_KEYS = [
  'score-skel-0',
  'score-skel-1',
  'score-skel-2',
] as const
const FINDING_SKELETON_KEYS = [
  'finding-skel-0',
  'finding-skel-1',
  'finding-skel-2',
  'finding-skel-3',
  'finding-skel-4',
] as const

interface ExitCardProps {
  item: EgressItem
  hideIp: boolean
}

const ExitCard = memo(({ item, hideIp }: ExitCardProps) => {
  return (
    <Box
      sx={{
        p: 1.2,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: (theme: Theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.025)'
            : 'rgba(0, 0, 0, 0.015)',
        display: 'flex',
        alignItems: 'center',
        gap: 1.2,
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 1.5,
          border: 1,
          borderColor: item.isProxy ? 'primary.main' : 'success.main',
          color: item.isProxy ? 'primary.main' : 'success.main',
          bgcolor: (theme: Theme) =>
            item.isProxy
              ? theme.palette.mode === 'dark'
                ? 'rgba(25, 118, 210, 0.12)'
                : 'rgba(25, 118, 210, 0.08)'
              : theme.palette.mode === 'dark'
                ? 'rgba(46, 125, 50, 0.12)'
                : 'rgba(46, 125, 50, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: '0.85rem',
          flexShrink: 0,
        }}
      >
        {item.id}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box
            component="span"
            sx={{
              fontSize: '1rem',
              display: 'inline-block',
              fontFamily:
                getSystem() === 'windows'
                  ? '"twemoji mozilla", sans-serif'
                  : 'sans-serif',
            }}
          >
            {getCountryFlag(item.countryCode)}
          </Box>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {[item.city, item.country].filter(Boolean).join(', ') ||
              item.country}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            · {[item.isp, item.asn].filter(Boolean).join(' · ')}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, mt: 0.2 }}>
          <Chip
            size="small"
            label={item.type}
            variant="outlined"
            sx={{
              height: 18,
              fontSize: '0.65rem',
              fontWeight: 600,
              '& .MuiChip-label': { px: 0.6 },
            }}
          />
          <Typography
            variant="caption"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              color: 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {hideIp ? '••••••••••' : item.ip}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
})

interface FindingRowProps {
  item: FindingItem
  isLast: boolean
}

const FindingRow = memo(({ item, isLast }: FindingRowProps) => {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        pb: isLast ? 0 : 1,
        borderBottom: isLast ? 0 : 1,
        borderColor: 'divider',
      }}
    >
      {/* 正常绿色对勾，问题红色叉号 */}
      {item.ok ? (
        <CheckCircleRounded
          sx={{
            color: 'success.main',
            fontSize: 18,
            mt: 0.3,
            flexShrink: 0,
          }}
        />
      ) : (
        <CancelRounded
          sx={{
            color: 'error.main',
            fontSize: 18,
            mt: 0.3,
            flexShrink: 0,
          }}
        />
      )}

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.8,
            flexWrap: 'wrap',
          }}
        >
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              minWidth: 80,
              color: 'text.secondary',
              flexShrink: 0,
            }}
          >
            {item.label}
          </Typography>

          {item.badge && (
            <Chip
              size="small"
              label={item.badge}
              color={item.ok ? 'success' : 'error'}
              variant="outlined"
              sx={{
                height: 20,
                fontSize: '0.68rem',
                fontWeight: 600,
                '& .MuiChip-label': { px: 0.6 },
              }}
            />
          )}

          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              color: item.ok ? 'text.primary' : 'error.main',
              wordBreak: 'break-word',
              flex: 1,
            }}
          >
            {item.text}
          </Typography>
        </Box>

        {item.helpText && (
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mt: 0.4,
              color: item.ok ? 'text.secondary' : 'error.main',
              fontSize: '0.72rem',
              lineHeight: 1.4,
            }}
          >
            {item.helpText}
          </Typography>
        )}
      </Box>
    </Box>
  )
})

interface IpScoreBarRowProps {
  item: IpScoreSource
  isLast: boolean
}

const getPurityStyle = (score: number, isDark: boolean) => {
  if (score >= 80) {
    return {
      key: 'home.components.ipInfo.detailModal.purityLevelPure' as const,
      color: isDark ? '#4ade80' : '#0f766e',
      bg: isDark ? 'rgba(34, 197, 94, 0.16)' : '#dcfce7',
    }
  }
  if (score >= 60) {
    return {
      key: 'home.components.ipInfo.detailModal.purityLevelGood' as const,
      color: isDark ? '#86efac' : '#15803d',
      bg: isDark ? 'rgba(34, 197, 94, 0.12)' : '#ecfdf5',
    }
  }
  if (score >= 40) {
    return {
      key: 'home.components.ipInfo.detailModal.purityLevelFair' as const,
      color: isDark ? '#fcd34d' : '#b45309',
      bg: isDark ? 'rgba(245, 158, 11, 0.15)' : '#fef3c7',
    }
  }
  if (score >= 20) {
    return {
      key: 'home.components.ipInfo.detailModal.purityLevelSuspicious' as const,
      color: isDark ? '#fdba74' : '#c2410c',
      bg: isDark ? 'rgba(249, 115, 22, 0.15)' : '#ffedd5',
    }
  }
  return {
    key: 'home.components.ipInfo.detailModal.purityLevelDanger' as const,
    color: isDark ? '#fca5a5' : '#b91c1c',
    bg: isDark ? 'rgba(239, 68, 68, 0.16)' : '#fee2e2',
  }
}

const IpScoreBarRow = memo(({ item, isLast }: IpScoreBarRowProps) => {
  const { t } = useTranslation()
  const hasScore = item.score !== null
  const clampedScore = hasScore
    ? Math.min(100, Math.max(0, item.score as number))
    : 0
  const lightStyle = getPurityStyle(clampedScore, false)

  return (
    <Box
      sx={{
        pb: isLast ? 0 : 1.2,
        borderBottom: isLast ? 0 : 1,
        borderColor: 'divider',
      }}
    >
      <Typography
        variant="caption"
        sx={{
          display: 'block',
          fontWeight: 600,
          color: 'text.primary',
          fontSize: '0.73rem',
          mb: 0.6,
        }}
      >
        {item.label}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.4 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* 红 -> 黄 -> 绿 渐变条与指针 */}
          <Box sx={{ position: 'relative', py: 0.5 }}>
            <Box
              sx={{
                height: 7,
                borderRadius: 999,
                background:
                  'linear-gradient(90deg, #dc2626 0%, #ea580c 25%, #eab308 50%, #65a30d 75%, #15803d 100%)',
                opacity: hasScore ? 1 : 0.35,
              }}
            />
            {hasScore && (
              <Box
                sx={{
                  position: 'absolute',
                  top: '50%',
                  left: `${clampedScore}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 3,
                  height: 15,
                  borderRadius: 1,
                  bgcolor: (theme: Theme) =>
                    theme.palette.mode === 'dark' ? '#f8fafc' : '#111827',
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.45)',
                }}
              />
            )}
          </Box>

          {/* 刻度标签 */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mt: 0.2,
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'text.secondary' }}
            >
              0 {t('home.components.ipInfo.detailModal.purityHighRisk')}
            </Typography>
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'text.secondary' }}
            >
              25
            </Typography>
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'text.secondary' }}
            >
              50
            </Typography>
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'text.secondary' }}
            >
              75
            </Typography>
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'text.secondary' }}
            >
              100 {t('home.components.ipInfo.detailModal.purityTrusted')}
            </Typography>
          </Box>
        </Box>

        {/* 右侧分数与状态徽章 */}
        {hasScore ? (
          <Box
            sx={(theme: Theme) => {
              const style = getPurityStyle(
                clampedScore,
                theme.palette.mode === 'dark',
              )
              return {
                minWidth: 74,
                px: 1,
                py: 0.45,
                borderRadius: 1.5,
                bgcolor: style.bg,
                color: style.color,
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'center',
                gap: 0.45,
                flexShrink: 0,
              }
            }}
          >
            <Typography
              component="span"
              sx={{
                fontWeight: 700,
                fontSize: '1.05rem',
                lineHeight: 1.1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {clampedScore}
            </Typography>
            <Typography
              component="span"
              sx={{ fontWeight: 700, fontSize: '0.72rem', lineHeight: 1.1 }}
            >
              {t(lightStyle.key)}
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              minWidth: 74,
              px: 1,
              py: 0.6,
              borderRadius: 1.5,
              bgcolor: 'action.hover',
              color: 'text.secondary',
              textAlign: 'center',
              flexShrink: 0,
            }}
          >
            <Typography variant="caption" sx={{ fontSize: '0.68rem' }}>
              {t('home.components.ipInfo.detailModal.purityUnavailable')}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
})
