// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "@octokit/rest";
import faunadb, { query as q, query } from "faunadb";
import { getFauna } from "../../src/faunaStorage";

const { Get, Ref, Collection, Query } = faunadb.query;

type Data = {
  count?: number;
  error?: string;
};

const faunaClient = getFauna();

const collectionName = "cache";
const indexName = `${collectionName}-index`;
const collectionRef = q.Collection(collectionName);
const indexRef = q.Index(indexName);

const cacheInit = () => {
  return Promise.all([
    // init cache collection
    faunaClient
      .query(
        q.CreateCollection({
          name: collectionName,
        })
      )
      .catch((e: any) => {
        if (e.message !== "instance already exists") throw e;
      }),

    // init index on cache
    faunaClient
      ?.query(
        q.CreateIndex({
          name: indexName,
          source: collectionRef,
          terms: [{ field: ["data", "key"] }],
          unique: true,
        })
      )
      .catch((e: any) => {
        if (e.message !== "instance already exists") throw e;
      }),
  ]);
};

type CacheElement<T> = {
  key: string;
  value: T;
  revalidateAfter: Date;
};

const getFromCache = async <T>(
  key: string
): Promise<CacheElement<T> | undefined> => {
  const res = await faunaClient
    .query<{ data: CacheElement<T> }>(q.Get(q.Match(indexRef, key)))
    .catch((e: any) => {
      if (e.name === "NotFound") return undefined;
    });
  return res?.data;
};

const saveToCache = async <T>(
  key: string,
  value: T
): Promise<CacheElement<T>> => {
  const data = {
    key,
    value,
    revalidateAfter: new Date().setTime(new Date().getTime() + 60 * 60 * 1000),
  };

  return faunaClient
    ?.query<{ data: CacheElement<T> }>(
      q.If(
        q.Exists(q.Match(indexRef, key)),
        q.Update(collectionRef, {
          data,
        }),
        q.Create(collectionRef, {
          data,
        })
      )
    )
    .then((res) => res.data);
};

const cacheAndRevalidate = async <T>(cacheKey: string, queryFn: Promise<T>) => {
  const cacheResult = await getFromCache<T>(cacheKey);
  if (cacheResult && new Date() <= cacheResult.revalidateAfter) {
    return cacheResult.value;
  }
  const res = await queryFn;
  return saveToCache(cacheKey, res).then((res) => res.value);
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

  await cacheInit();

  const ownerRepoInput = req.query.repo;
  let suffixes = req.query.suffix;
  if (typeof suffixes === "string") {
    suffixes = suffixes.split(",");
  }

  const repoConf = {
    owner: ownerRepoInput[0],
    repo: ownerRepoInput[1],
  };

  const cachePrefix = repoConf.owner + repoConf.repo;

  if (!repoConf.owner || !repoConf.repo) {
    return res
      .status(400)
      .json({ error: "repos have to be in OWNER/REPO syntax" });
  }

  const repoInfo = await cacheAndRevalidate(
    `${cachePrefix}-repo-info-${repoConf.owner}-${repoConf.repo}`,
    octokit.repos.get(repoConf).catch((error) => {
      res.status(400).json({ error: error.response.data.message });
      return null;
    })
  );

  if (!repoInfo) return;

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
  res.status(200);

  const countCache = await getFromCache<number>(cachePrefix + "-total");

  console.debug("cache-hit", countCache);

  if (!countCache || new Date() > countCache.revalidateAfter) {
    let releaseIds: number[] = [];
    let page = 0;

    do {
      const newReleaseIds = (
        await cacheAndRevalidate(
          `${cachePrefix}-release-list-${repoConf.owner}-${repoConf.repo}-p${page}`,
          octokit.repos.listReleases({ ...repoConf, per_page: 100, page })
        )
      ).data.map((release) => release.id);
      if (!newReleaseIds.length) {
        break;
      }
      releaseIds = [...releaseIds, ...newReleaseIds];
      page++;
    } while (true);

    const downloadsByRelease = await Promise.all(
      releaseIds.map(async (release_id) => {
        const assets = await cacheAndRevalidate(
          `${cachePrefix}-release_assets-${release_id}`,
          octokit.repos.listReleaseAssets({
            ...repoConf,
            release_id,
          })
        );

        if (!!suffixes) {
          const filteredAssets = assets.data.filter((asset) => {
            const nameElements = asset.name.split(".");
            return suffixes.includes(nameElements[nameElements.length - 1]);
          });
          return filteredAssets
            .map((asset) => asset.download_count)
            .filter((value) => value !== -Infinity)
            .reduce((pv, cv) => pv + cv, 0);
        }

        const downloadCounts = assets.data.map((asset) => asset.download_count);
        return Math.max(...downloadCounts);
      })
    );

    const totalDownloads = downloadsByRelease
      .filter((value) => value !== -Infinity)
      .reduce((pv, cv) => pv + cv, 0);

    await saveToCache(cachePrefix + "-total", totalDownloads);
    return res.json({ count: totalDownloads });
  }

  return res.json({ count: countCache?.value || -Infinity });
}
