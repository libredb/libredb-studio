--
-- PostgreSQL database dump
--
-- https://www.kaggle.com/datasets/ibrahimelsayed182/titanic-dataset

-- Dumped from database version 15.2
-- Dumped by pg_dump version 15.2 (Ubuntu 15.2-1.pgdg22.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_table_access_method = heap;

--
-- Name: passenger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passenger (
    passengerid integer NOT NULL,
    survived double precision,
    pclass integer,
    name text,
    sex text,
    age double precision,
    sibsp integer,
    parch integer,
    ticket text,
    fare double precision,
    cabin text,
    embarked text,
    wikiid double precision,
    name_wiki text,
    age_wiki double precision,
    hometown text,
    boarded text,
    destination text,
    lifeboat text,
    body text,
    class integer
);


--
-- Data for Name: passenger; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.passenger (passengerid, survived, pclass, name, sex, age, sibsp, parch, ticket, fare, cabin, embarked, wikiid, name_wiki, age_wiki, hometown, boarded, destination, lifeboat, body, class) FROM stdin;
1	0	3	Braund, Mr. Owen Harris	male	22	1	0	A/5 21171	7.25	\N	S	691	Braund, Mr. Owen Harris	22	Bridgerule, Devon, England	Southampton	Qu'Appelle Valley, Saskatchewan, Canada	\N	\N	3
2	1	1	Cumings, Mrs. John Bradley (Florence Briggs Thayer)	female	38	1	0	PC 17599	71.2833	C85	C	90	Cumings, Mrs. Florence Briggs (née Thayer)	35	New York, New York, US	Cherbourg	New York, New York, US	4	\N	1
3	1	3	Heikkinen, Miss. Laina	female	26	0	0	STON/O2. 3101282	7.925	\N	S	865	Heikkinen, Miss Laina	26	Jyväskylä, Finland	Southampton	New York City	14?	\N	3
4	1	1	Futrelle, Mrs. Jacques Heath (Lily May Peel)	female	35	1	0	113803	53.1	C123	S	127	Futrelle, Mrs. Lily May (née Peel)	35	Scituate, Massachusetts, US	Southampton	Scituate, Massachusetts, US	D	\N	1
5	0	3	Allen, Mr. William Henry	male	35	0	0	373450	8.05	\N	S	627	Allen, Mr. William Henry	35	Birmingham, West Midlands, England	Southampton	New York City	\N	\N	3
6	0	3	Moran, Mr. James	male	\N	0	0	330877	8.4583	\N	Q	785	Doherty, Mr. William John (aka "James Moran")	22	Cork, Ireland	Queenstown	New York City	\N	\N	3
7	0	1	McCarthy, Mr. Timothy J	male	54	0	0	17463	51.8625	E46	S	200	McCarthy, Mr. Timothy J.	54	Dorchester, Massachusetts, US	Southampton	Dorchester, Massachusetts, US	\N	175MB	1
8	0	3	Palsson, Master. Gosta Leonard	male	2	3	1	349909	21.075	\N	S	1108	Pålsson, Master Gösta Leonard	2	Bjuv, Skåne, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
9	1	3	Johnson, Mrs. Oscar W (Elisabeth Vilhelmina Berg)	female	27	0	2	347742	11.1333	\N	S	902	Johnson, Mrs. Elisabeth Vilhelmina (née Berg)	26	St. Charles, Illinois, US	Southampton	St. Charles, Illinois, US	15	\N	3
10	1	2	Nasser, Mrs. Nicholas (Adele Achem)	female	14	1	0	237736	30.0708	\N	C	520	Nassr Allah, Mrs. Adal (née Akim)[62][77]	14	Zahlé, Lebanon, Ottoman Empire	Cherbourg	Cleveland, Ohio, US	?	\N	2
11	1	3	Sandstrom, Miss. Marguerite Rut	female	4	1	1	PP 9549	16.7	G6	S	1193	Sandström, Miss Marguerite Rut	4	Motala, Östergötland, Sweden	Southampton	San Francisco, US	13	\N	3
12	1	1	Bonnell, Miss. Elizabeth	female	58	0	0	113783	26.55	C103	S	35	Bonnell, Miss Elizabeth	61	Youngstown, Ohio, US	Southampton	Youngstown, Ohio, US	8	\N	1
13	0	3	Saundercock, Mr. William Henry	male	20	0	0	A/5. 2151	8.05	\N	S	1196	Saundercock, Mr. William Henry	19	St Austell, Cornwall, England	Southampton	New York City	\N	\N	3
14	0	3	Andersson, Mr. Anders Johan	male	39	1	5	347082	31.275	\N	S	632	Andersson, Mr. Anders Johan	39	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
15	0	3	Vestrom, Miss. Hulda Amanda Adolfina	female	14	0	0	350406	7.8542	\N	S	1286	Veström, Miss Hulda Amanda Adolfina	14	Salmunds, Gotland, Sweden	Southampton	Los Angeles, US	\N	\N	3
16	1	2	Hewlett, Mrs. (Mary D Kingcome) 	female	55	0	0	248706	16	\N	S	446	Hewlett, Mrs. Mary Dunbar (née Kingcome)	56	Lucknow, British India, UK[note 3]	Southampton	Rapid City, South Dakota, US	13	\N	2
17	0	3	Rice, Master. Eugene	male	2	4	1	382652	29.125	\N	Q	1151	Rice, Master Eugene Francis	2	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	\N	3
18	1	2	Williams, Mr. Charles Eugene	male	\N	0	0	244373	13	\N	S	604	Williams, Mr. Charles Eugene	23	Harrow, London, England	Southampton	Chicago, Illinois, US	14	\N	2
19	0	3	Vander Planke, Mrs. Julius (Emelia Maria Vandemoortele)	female	31	1	0	345763	18	\N	S	1280	Vanderplancke, Mrs. Emelie Maria (née Vandemoortele)	31	Pittem, Belgium	Southampton	Fremont, Ohio, US	\N	\N	3
20	1	3	Masselmani, Mrs. Fatima	female	\N	0	0	2649	7.225	\N	C	1053	Muslamani, Mrs. Fatimah	22	Tebnine, Lebanon	Cherbourg	Michigan City, Indiana, US	C	\N	3
21	0	2	Fynney, Mr. Joseph J	male	35	0	0	239865	26	\N	S	416	Fynney, Mr. Joseph J.	35	Liverpool, Merseyside, England, UK	Southampton	Montreal, Quebec, Canada	\N	322M	2
22	1	2	Beesley, Mr. Lawrence	male	34	0	0	248698	13	D56	S	346	Beesley, Mr. Lawrence	34	London, England, UK	Southampton	Toronto, Ontario, Canada	13	\N	2
23	1	3	McGowan, Miss. Anna "Annie"	female	15	0	0	330923	8.0292	\N	Q	1014	McGowan, Miss Anna F. "Annie"	16	Massbrook, Mayo, Ireland	Queenstown	Chicago, Illinois, US	13	\N	3
24	1	1	Sloper, Mr. William Thompson	male	28	0	0	113788	35.5	A6	S	261	Sloper, Mr. William Thompson	28	New Britain, Connecticut, US	Southampton	New Britain, Connecticut, US	7	\N	1
25	0	3	Palsson, Miss. Torborg Danira	female	8	3	1	349909	21.075	\N	S	1105	Pålsson, Miss Torborg Danira	8	Bjuv, Skåne, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
26	1	3	Asplund, Mrs. Carl Oscar (Selma Augusta Emilia Johansson)	female	38	1	5	347077	31.3875	\N	S	649	Asplund, Mrs. Selma Augusta Emilia (née Johansson)	38	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	15	\N	3
27	0	3	Emir, Mr. Farred Chehab	male	\N	0	0	2631	7.225	\N	C	1205	Shihab, Mr. Amir Faris	25	Hadath, Lebanon	Cherbourg	New York City	\N	\N	3
28	0	1	Fortune, Mr. Charles Alexander	male	19	3	2	19950	263	C23 C25 C27	S	118	Fortune, Mr. Charles Alexander	19	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	\N	\N	1
29	1	3	O'Dwyer, Miss. Ellen "Nellie"	female	\N	0	0	330959	7.8792	\N	Q	1086	O'Dwyer, Miss Ellen "Nellie"	25	Limerick, Limerick, Ireland	Queenstown	New York City	?	\N	3
30	0	3	Todoroff, Mr. Lalio	male	\N	0	0	349216	7.8958	\N	S	1258	Todoroff, Mr. Lalio	23	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
31	0	1	Uruchurtu, Don. Manuel E	male	40	0	0	PC 17601	27.7208	\N	C	302	Uruchurtu, Don Manuel E.	40	Mexico City, Mexico	Cherbourg	Mexico City, Mexico	\N	\N	1
194	1	2	Navratil, Master. Michel M	male	3	1	1	230080	26	F2	S	522	Navratil, Master Michel Marcel	3	Nice, France	Southampton	New York City	D	\N	2
32	1	1	Spencer, Mrs. William Augustus (Marie Eugenie)	female	\N	1	0	PC 17569	146.5208	B78	C	275	Spencer, Mrs. Marie Eugénie (née Demougeot)	45	New York, New York, US	Cherbourg	New York, New York, US	6	\N	1
33	1	3	Glynn, Miss. Mary Agatha	female	\N	0	0	335677	7.75	\N	Q	826	Glynn, Miss Mary Agatha	19	Killaloe, Clare, Ireland	Queenstown	Washington, DC, US	13	\N	3
34	0	2	Wheadon, Mr. Edward H	male	66	0	0	C.A. 24579	10.5	\N	S	600	Wheadon, Mr. Edward H.	66	Guernsey, Channel Islands	Southampton	Edgewood, Rhode Island, US	\N	\N	2
35	0	1	Meyer, Mr. Edgar Joseph	male	28	1	0	PC 17604	82.1708	\N	C	202	Meyer, Mr. Edgar Joseph	28	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
36	0	1	Holverson, Mr. Alexander Oskar	male	42	1	0	113789	52	\N	S	163	Holverson, Mr. Alexander Oskar	42	New York, New York, US	Southampton	New York, New York, US	\N	38MB	1
37	1	3	Mamee, Mr. Hanna	male	\N	0	0	2677	7.2292	\N	C	998	Mamee, Mr. Hanna	20	Tripoli, Lebanon	Cherbourg	Philadelphia, Pennsylvania, US	15	\N	3
38	0	3	Cann, Mr. Ernest Charles	male	21	0	0	A./5. 2152	8.05	\N	S	712	Cann, Mr. Ernest Charles	21	Penwithick, Cornwall, England	Southampton	New York City	\N	\N	3
39	0	3	Vander Planke, Miss. Augusta Maria	female	18	2	0	345764	18	\N	S	1281	Vanderplancke, Miss Augusta Maria	18	Zwevezele, Belgium	Southampton	Fremont, Ohio, US	\N	\N	3
40	1	3	Nicola-Yarred, Miss. Jamila	female	14	1	0	2651	11.2417	\N	C	1071	Niqula-Yarid, Miss Jamilah	14	El-Hakour, Lebanon	Cherbourg	Jacksonville, Florida, US	C	\N	3
41	0	3	Ahlin, Mrs. Johan (Johanna Persdotter Larsson)	female	40	1	0	7546	9.475	\N	S	619	Ahlin, Mrs. Johanna Persdotter (née Larsson)	40	Göteborg, Västergötland, Sweden	Southampton	Akeley, Minnesota, US	\N	\N	3
42	0	2	Turpin, Mrs. William John Robert (Dorothy Ann Wonnacott)	female	27	1	0	11668	21	\N	S	581	Turpin, Mrs. Dorothy Ann (née Wonnacott)	27	Plymouth, Devon, England	Southampton	Salt Lake City, Utah, US	\N	\N	2
43	0	3	Kraeff, Mr. Theodor	male	\N	0	0	349253	7.8958	\N	C	946	Kraeff, Mr. Theodor	\N	Vetren, Bulgaria	Cherbourg	Madison, Wisconsin, US	\N	\N	3
44	1	2	Laroche, Miss. Simonne Marie Anne Andree	female	3	1	2	SC/Paris 2123	41.5792	\N	C	487	Laroche, Miss Simoné Marie Anne Andrée	3	Paris, France	Cherbourg	Cap-Haïtien, Haiti	14	\N	2
45	1	3	Devaney, Miss. Margaret Delia	female	19	0	0	330958	7.8792	\N	Q	778	Devaney, Miss Margaret Delia	19	Kilmacowen, Sligo, Ireland	Queenstown	New York City	C	\N	3
46	0	3	Rogers, Mr. William John	male	\N	0	0	S.C./A.4. 23567	8.05	\N	S	1159	Rogers, Mr. William John	29	Pontardawe, West Glamorgan, Wales	Southampton	New York City	\N	\N	3
47	0	3	Lennon, Mr. Denis	male	\N	1	0	370371	15.5	\N	Q	968	Lennon, Mr. Denis	20	Ballymahon, Longford, Ireland	Queenstown	New York City	\N	\N	3
48	1	3	O'Driscoll, Miss. Bridget	female	\N	0	0	14311	7.75	\N	Q	1085	O'Driscoll, Miss Bridget	24	Ballydehob, Cork, Ireland	Queenstown	Jersey City, New Jersey, US	D	\N	3
49	0	3	Samaan, Mr. Youssef	male	\N	2	0	2662	21.6792	\N	C	1191	Sa'maan, Mr. Youssef Omar "Joseph"	16	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	\N	\N	3
50	0	3	Arnold-Franchi, Mrs. Josef (Josefine Franchi)	female	18	1	0	349237	17.8	\N	S	645	Arnold-Franchi, Mrs. Josefine (née Franchi)	18	Altdorf, Uri, Switzerland	Southampton	New Glarus, Wisconsin, US	\N	\N	3
51	0	3	Panula, Master. Juha Niilo	male	7	4	1	3101295	39.6875	\N	S	1112	Panula, Master Juha Niilo	7	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
52	0	3	Nosworthy, Mr. Richard Cater	male	21	0	0	A/4. 39886	7.8	\N	S	1076	Nosworthy, Mr. Richard Cater	21	Newton Abbot, Devon, England	Southampton	Buffalo, New York, US	\N	\N	3
53	1	1	Harper, Mrs. Henry Sleeper (Myna Haxtun)	female	49	1	0	PC 17572	76.7292	D33	C	148	Harper, Mrs. Myna (née Haxtun)	49	New York, New York, US	Cherbourg	New York, New York, US	3	\N	1
54	1	2	Faunthorpe, Mrs. Lizzie (Elizabeth Anne Wilkinson)	female	29	1	0	2926	26	\N	S	603	Wilkinson, Miss Elizabeth Anne (alias Mrs. Elizabeth Faunthorpe)	29	Manchester, England	Southampton	Philadelphia, Pennsylvania, US	16	\N	2
55	0	1	Ostby, Mr. Engelhart Cornelius	male	65	0	1	113509	61.9792	B30	C	220	Ostby, Mr. Engelhart Cornelius	64	Providence, Rhode Island, US	Southampton	Providence, Rhode Island, US	\N	234MB	1
56	1	1	Woolner, Mr. Hugh	male	\N	0	0	19947	35.5	C52	S	324	Woolner, Mr. Hugh	45	London, England, UK	Southampton	New York, New York, US	D	\N	1
57	1	2	Rugg, Miss. Emily	female	21	0	0	C.A. 31026	10.5	\N	S	559	Rugg, Miss Emily	21	Guernsey, Channel Islands	Southampton	Wilmington, Delaware, US	12	\N	2
58	0	3	Novel, Mr. Mansouer	male	28.5	0	0	2697	7.2292	\N	C	1075	Nofal, Mr. Mansur	20	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	181MB	3
59	1	2	West, Miss. Constance Mirium	female	5	1	2	C.A. 34651	27.75	\N	S	598	West, Miss Constance Mirium	4	Bournemouth, Dorset, England	Southampton	Gainesville, Florida, US	10	\N	2
60	0	3	Goodwin, Master. William Frederick	male	11	5	2	CA 2144	46.9	\N	S	835	Goodwin, Master William Frederick	13	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
61	0	3	Sirayanian, Mr. Orsen	male	22	0	0	2669	7.2292	\N	C	1209	Sirkanian, Mr. Arsun	22	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	\N	\N	3
62	1	1	Icard, Miss. Amelie	female	38	0	0	113572	80	B28	\N	284	and maid, Miss Amelie "Amelia" Icard	38	New York, New York, US	Southampton	New York, New York, US	6	\N	1
63	0	1	Harris, Mr. Henry Birkhardt	male	45	1	0	36973	83.475	C83	S	149	Harris, Mr. Henry Birkhardt	45	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
64	0	3	Skoog, Master. Harald	male	4	3	2	347088	27.9	\N	S	1218	Skoog, Master Harald	5	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
65	0	1	Stewart, Mr. Albert A	male	\N	0	0	PC 17605	27.7208	\N	C	282	Stewart, Mr. Albert A.	54	Cincinnati, Ohio, US	Cherbourg	Gallipolis, Ohio, US	\N	\N	1
66	1	3	Moubarek, Master. Gerios	male	\N	1	1	2661	15.2458	\N	C	1045	Mubarik, Master Gerios	7	Hardîne, Lebanon	Cherbourg	Houtzdale, Pennsylvania, US	C	\N	3
67	1	2	Nye, Mrs. (Elizabeth Ramell)	female	29	0	0	C.A. 29395	10.5	F33	S	527	Nye, Mrs. Elizabeth (née Ramell)	29	East Orange, New Jersey, US	Southampton	East Orange, New Jersey, US	11	\N	2
68	0	3	Crease, Mr. Ernest James	male	19	0	0	S.P. 3464	8.1583	\N	S	746	Crease, Mr. Ernest James	19	Bristol, Avon, England	Southampton	Cleveland, Ohio, US	\N	\N	3
69	1	3	Andersson, Miss. Erna Alexandra	female	17	4	2	3101281	7.925	\N	S	639	Andersson, Miss Erna Alexandra	17	Kullaa, Finland	Southampton	New York City	D	\N	3
70	0	3	Kink, Mr. Vincenz	male	26	2	0	315151	8.6625	\N	S	942	Kink, Mr. Vincenz	26	Zürich, Switzerland	Southampton	Milwaukee, Wisconsin, US	\N	\N	3
71	0	2	Jenkin, Mr. Stephen Curnow	male	32	0	0	C.A. 33111	10.5	\N	S	470	Jenkin, Mr. Stephen Curnow	32	St. Ives, Cornwall, England	Southampton	Houghton, Michigan, US	\N	\N	2
72	0	3	Goodwin, Miss. Lillian Amy	female	16	5	2	CA 2144	46.9	\N	S	833	Goodwin, Miss Lillian Amy	16	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
73	0	2	Hood, Mr. Ambrose Jr	male	21	0	0	S.O.C. 14879	73.5	\N	S	458	Hood, Mr. Ambrose Jr.	21	Fritham, Hampshire, England	Southampton	Manitoba, Canada	\N	\N	2
74	0	3	Chronopoulos, Mr. Apostolos	male	26	1	0	2680	14.4542	\N	C	724	Chronopoulos, Mr. Apostolos	26	Agios Sostis, Peloponnese, Greece	Cherbourg	New York City	\N	\N	3
75	1	3	Bing, Mr. Lee	male	32	0	0	1601	56.4958	\N	S	960	Lee, Mr. Bing	32	Hong Kong, China	Southampton	New York City	C	\N	3
76	0	3	Moen, Mr. Sigurd Hansen	male	25	0	0	348123	7.65	F G73	S	1033	Moen, Mr. Sigurd Hansen	25	Bergen, Norway	Southampton	Minneapolis, Minnesota, US	\N	309M	3
77	0	3	Staneff, Mr. Ivan	male	\N	0	0	349208	7.8958	\N	S	1229	Staneff, Mr. Ivan	23	Debnevo, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
78	0	3	Moutal, Mr. Rahamin Haim	male	\N	0	0	374746	8.05	\N	S	1043	Moutal, Mr. Rahamin Haim	28	London, England	Southampton	New York City	\N	\N	3
79	1	2	Caldwell, Master. Alden Gates	male	0.83	0	2	248738	29	\N	S	366	Caldwell, Master Alden Gates	0.83	Bangkok, Siam	Southampton	Roseville, Illinois, US	13	\N	2
80	1	3	Dowdell, Miss. Elizabeth	female	30	0	0	364516	12.475	\N	S	786	Dowdell, Miss Elizabeth	31	New York City, New York, US	Southampton	New York City	13	\N	3
81	0	3	Waelens, Mr. Achille	male	22	0	0	345767	9	\N	S	1288	Waelens, Mr. Achille	22	Ruiselede, West Flanders, Belgium	Southampton	Stanton, Ohio, US	\N	140MB	3
82	1	3	Sheerlinck, Mr. Jan Baptist	male	29	0	0	345779	9.5	\N	S	1199	Scheerlinck, Mr. Jean Baptiste	29	Haaltert, East Flanders, Belgium	Southampton	Detroit, Michigan, US	11	\N	3
83	1	3	McDermott, Miss. Brigdet Delia	female	\N	0	0	330932	7.7875	\N	Q	1011	McDermott, Miss Bridget Delia	31	Lahardane, Mayo, Ireland	Queenstown	Chicago, Illinois, US	13	\N	3
84	0	1	Carrau, Mr. Francisco M	male	28	0	0	113059	47.1	\N	S	55	Carrau, Mr. Francisco M.	31	Montevideo, Uruguay	Southampton	Montevideo, Uruguay	\N	\N	1
85	1	2	Ilett, Miss. Bertha	female	17	0	0	SO/C 14885	10.5	\N	S	464	Ilett, Miss Bertha	17	Jersey, Channel Islands	Southampton	Atlanta, Georgia, US	?	\N	2
86	1	3	Backstrom, Mrs. Karl Alfred (Maria Mathilda Gustafsson)	female	33	3	0	3101278	15.85	\N	S	664	Backström, Mrs. Maria Mathilda (née Gustafsson)[62][80]	33	Kotka, Finland	Southampton	New York City	D	\N	3
87	0	3	Ford, Mr. William Neal	male	16	1	3	W./C. 6608	34.375	\N	S	817	Ford, Mr. William Neal Thomas	16	Rotherfield, East Sussex, England	Southampton	Essex County, New Jersey, US	\N	\N	3
88	0	3	Slocovski, Mr. Selman Francis	male	\N	0	0	SOTON/OQ 392086	8.05	\N	S	1221	Slocovski, Mr. Selman Francis	20	London, England	Southampton	New York City	\N	\N	3
89	1	1	Fortune, Miss. Mabel Helen	female	23	3	2	19950	263	C23 C25 C27	S	117	Fortune, Miss Mabel Helen	23	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	10	\N	1
90	0	3	Celotti, Mr. Francesco	male	24	0	0	343275	8.05	\N	S	719	Celotti, Mr. Francesco	24	Milan[83], Italy	Southampton	New York City	\N	\N	3
91	0	3	Christmann, Mr. Emil	male	29	0	0	343276	8.05	\N	S	723	Christmann, Mr. Emil	29	London, England	Southampton	New York City	\N	\N	3
92	0	3	Andreasson, Mr. Paul Edvin	male	20	0	0	347466	7.8542	\N	S	642	Andreasson, Mr. Paul Edvin	20	Kalfsnäs, Småland, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
93	0	1	Chaffee, Mr. Herbert Fuller	male	46	1	0	W.E.P. 5734	61.175	E31	S	69	Chaffee, Mr. Hubert Fuller	46	Amenia, North Dakota, US	Southampton	Amenia, North Dakota, US	\N	\N	1
94	0	3	Dean, Mr. Bertram Frank	male	26	1	2	C.A. 2315	20.575	\N	S	770	Dean, Mr. Bertram Frank	25	Bartley Farm, Hampshire, England	Southampton	Wichita, Kansas, US	\N	\N	3
95	0	3	Coxon, Mr. Daniel	male	59	0	0	364500	7.25	\N	S	745	Coxon, Mr. Daniel	59	London, England	Southampton	Merrill, Wisconsin, US	\N	\N	3
96	0	3	Shorney, Mr. Charles Joseph	male	\N	0	0	374910	8.05	\N	S	1207	Shorney, Mr. Charles Joseph	22	Heron's Ghyll, East Sussex, England	Southampton	New York, US	\N	240{?}MB	3
97	0	1	Goldschmidt, Mr. George B	male	71	0	0	PC 17754	34.6542	A5	C	133	Goldschmidt, Mr. George B.	71	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
98	1	1	Greenfield, Mr. William Bertram	male	23	0	1	PC 17759	63.3583	D10 D12	C	140	Greenfield, Mr. William Bertram	23	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
99	1	2	Doling, Mrs. John T (Ada Julia Bone)	female	34	0	1	231919	23	\N	S	400	Doling, Mrs. Ada Julia (née Bone)	34	Southampton, Hampshire, England, UK	Southampton	New York City	?	\N	2
100	0	2	Kantor, Mr. Sinai	male	34	1	0	244367	26	\N	S	472	Kantor, Mr. Sinai	34	Vitebsk, Russian Empire	Southampton	Bronx, New York, US	\N	283MB	2
101	0	3	Petranec, Miss. Matilda	female	28	0	0	349245	7.8958	\N	S	1130	Petranec, Miss Matilda	28	Vagovina, Croatia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
102	0	3	Petroff, Mr. Pastcho ("Pentcho")	male	\N	0	0	349215	7.8958	\N	S	1132	Petroff, Mr. Pastcho	29	Belish, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
103	0	1	White, Mr. Richard Frasar	male	21	0	1	35281	77.2875	D26	S	309	White, Mr. Richard Frasar	21	Brunswick, Maine, US	Southampton	Brunswick, Maine, US	\N	169MB	1
104	0	3	Johansson, Mr. Gustaf Joel	male	33	0	0	7540	8.6542	\N	S	897	Johansson, Mr. Gustaf Joel	33	Bäckebo, Småland, Sweden	Southampton	Cheyenne, North Dakota, US	\N	285MB	3
105	0	3	Gustafsson, Mr. Anders Vilhelm	male	37	2	0	3101276	7.925	\N	S	843	Gustafsson, Mr. Anders Vilhelm	37	Ruotsinpyhtää, Finland	Southampton	New York City	\N	98MB	3
106	0	3	Mionoff, Mr. Stoytcho	male	28	0	0	349207	7.8958	\N	S	1027	Mihoff, Mr. Stoytcho	28	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
107	1	3	Salkjelsvik, Miss. Anna Kristine	female	21	0	0	343120	7.65	\N	S	1186	Salkjelsvik, Miss Anna Kristine	21	Ålesund, Møre og Romsdal, Norway	Southampton	Proctor, Minnesota, US	C	\N	3
108	1	3	Moss, Mr. Albert Johan	male	\N	0	0	312991	7.775	\N	S	1041	Moss, Mr. Albert Johan	29	Bergen, Norway	Southampton	New York City	B	\N	3
109	0	3	Rekic, Mr. Tido	male	38	0	0	349249	7.8958	\N	S	1144	Rekić, Mr. Tido	38	Bosanska Krupa, Bosnia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
110	1	3	Moran, Miss. Bertha	female	\N	1	0	371110	24.15	\N	Q	1037	Moran, Miss Bertha Bridget	28	Askeaton, Limerick, Ireland	Queenstown	Brooklyn, New York, US	16	\N	3
111	0	1	Porter, Mr. Walter Chamberlain	male	47	0	0	110465	52	C110	S	231	Porter, Mr. Walter Chamberlain	46	Worcester, Massachusetts, US	Southampton	Worcester, Massachusetts, US	\N	207MB	1
112	0	3	Zabour, Miss. Hileni	female	14.5	1	0	2665	14.4542	\N	C	884	Jabbour, Miss Hileni	16	Unknown, Syria	Cherbourg	New York City	\N	328MM	3
113	0	3	Barton, Mr. David John	male	22	0	0	324669	8.05	\N	S	676	Barton, Mr. David John	22	Cambridge, Cambridgeshire, England	Southampton	New York City	\N	\N	3
114	0	3	Jussila, Miss. Katriina	female	20	1	0	4136	9.825	\N	S	915	Jussila, Miss Katriina	20	Paavola, Northern Ostrobothnia, Finland	Southampton	New York City	\N	\N	3
115	0	3	Attalah, Miss. Malake	female	17	0	0	2627	14.4583	\N	C	659	Atta Allah, Miss Malakah	17	Beirut, Lebanon	Cherbourg	New York City	\N	\N	3
116	0	3	Pekoniemi, Mr. Edvard	male	21	0	0	STON/O 2. 3101294	7.925	\N	S	1124	Pekoniemi, Mr. Edvard Johannes	21	Heinola, Finland	Southampton	New York City	\N	\N	3
117	0	3	Connors, Mr. Patrick	male	70.5	0	0	370369	7.75	\N	Q	735	Connors, Mr. Patrick John	61	Charleville, Cork, Ireland	Queenstown	New York City	\N	171MB	3
118	0	2	Turpin, Mr. William John Robert	male	29	1	0	11668	21	\N	S	580	Turpin, Mr. William John Robert	29	Plymouth, Devon, England	Southampton	Salt Lake City, Utah, US	\N	\N	2
119	0	1	Baxter, Mr. Quigg Edmond	male	24	0	1	PC 17558	247.5208	B58 B60	C	24	Baxter, Mr. Quigg Edmond	24	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	\N	\N	1
120	0	3	Andersson, Miss. Ellis Anna Maria	female	2	4	2	347082	31.275	\N	S	638	Andersson, Miss Ellis Anna Maria	2	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
121	0	2	Hickman, Mr. Stanley George	male	21	2	0	S.O.C. 14879	73.5	\N	S	449	Hickman, Mr. Stanley George	20	Fritham, Hampshire, England	Southampton	The Pas, Manitoba, Canada	\N	\N	2
122	0	3	Moore, Mr. Leonard Charles	male	\N	0	0	A4. 54510	8.05	\N	S	1036	Moore, Mr. Leonard Charles	19	Kingston upon Thames, London, England	Southampton	Hoboken, New Jersey, US	\N	\N	3
123	0	2	Nasser, Mr. Nicholas	male	32.5	1	0	237736	30.0708	\N	C	519	Nassr Allah, Mr. Niqula Khalil	28	Zahlé, Lebanon, Ottoman Empire[note 7]	Cherbourg	Cleveland, Ohio, US	\N	43MB	2
124	1	2	Webber, Miss. Susan	female	32.5	0	0	27267	13	E101	S	590	Webber, Miss Susan	37	Bude, Cornwall, England	Southampton	Hartford, Connecticut, US	12	\N	2
125	0	1	White, Mr. Percival Wayland	male	54	0	1	35281	77.2875	D26	S	308	White, Mr. Percival Wayland	54	Brunswick, Maine, US	Southampton	Brunswick, Maine, US	\N	\N	1
126	1	3	Nicola-Yarred, Master. Elias	male	12	1	0	2651	11.2417	\N	C	1072	Niqula-Yarid, Master Ilyas	12	El-Hakour, Lebanon	Cherbourg	Jacksonville, Florida, US	C	\N	3
127	0	3	McMahon, Mr. Martin	male	\N	0	0	370372	7.75	\N	Q	1016	McMahon, Mr. Martin	20	Craghbrien, Clare, Ireland	Queenstown	New York City	\N	\N	3
128	1	3	Madsen, Mr. Fridtjof Arne	male	24	0	0	C 17369	7.1417	\N	S	993	Madsen, Mr. Fridtjof Arne	24	Trondheim, Norway	Southampton	Brooklyn, New York, US	13	\N	3
129	1	3	Peter, Miss. Anna	female	\N	1	1	2668	22.3583	F E69	C	703	Butrus-Youssef, Miss Marianna	2	Sar'al, Syria[81]	Cherbourg	Detroit, Michigan, US	C	\N	3
130	0	3	Ekstrom, Mr. Johan	male	45	0	0	347061	6.975	\N	S	796	Ekström, Mr. Johan	45	Effington Rut, South Dakota, US	Southampton	Effington Rut, South Dakota, US	\N	\N	3
131	0	3	Drazenoic, Mr. Jozef	male	33	0	0	349241	7.8958	\N	C	788	Draženović, Mr. Jozef	33	Hrastelnica, Croatia	Cherbourg	New York City	\N	51MB	3
132	0	3	Coelho, Mr. Domingos Fernandeo	male	20	0	0	SOTON/O.Q. 3101307	7.05	\N	S	726	Coelho, Mr. Domingos Fernandes	20	Funchal, Madeira Islands, Portugal	Southampton	New York City	\N	\N	3
133	0	3	Robins, Mrs. Alexander A (Grace Charity Laury)	female	47	1	0	A/5. 3337	14.5	\N	S	1158	Robins, Mrs. Grace Charity (née Laury)	47	St Austell, Cornwall, England	Southampton	Yonkers, New York, US	\N	7MB	3
134	1	2	Weisz, Mrs. Leopold (Mathilde Francoise Pede)	female	29	1	0	228414	26	\N	S	592	Weisz, Mrs. Mathilde Françoise (née Pëde)	37	Bromsgrove, Worcestershire, England	Southampton	Montreal, Quebec, Canada	10	\N	2
135	0	2	Sobey, Mr. Samuel James Hayden	male	25	0	0	C.A. 29178	13	\N	S	571	Sobey, Mr. Samuel James Hayden	25	Porthallow, Cornwall, England	Southampton	Houghton, Michigan, US	\N	\N	2
136	0	2	Richard, Mr. Emile	male	23	0	0	SC/PARIS 2133	15.0458	\N	C	552	Richard, Mr. Emile Philippe	23	Paris, France	Cherbourg	Montreal, Quebec, Canada	\N	\N	2
137	1	1	Newsom, Miss. Helen Monypeny	female	19	0	2	11752	26.2833	D47	S	216	Newsom, Miss Helen Monypeny	19	New York, New York, US	Southampton	New York, New York, US	5	\N	1
138	0	1	Futrelle, Mr. Jacques Heath	male	37	1	0	113803	53.1	C123	S	126	Futrelle, Mr. Jacques Heath	37	Scituate, Massachusetts, US	Southampton	Scituate, Massachusetts, US	\N	\N	1
139	0	3	Osen, Mr. Olaf Elon	male	16	0	0	7534	9.2167	\N	S	1103	Osén, Mr. Olaf Elon	16	Hedesunda, Gävleborg, Sweden	Southampton	Mitchell, South Dakota, US	\N	\N	3
140	0	1	Giglio, Mr. Victor	male	24	0	0	PC 17593	79.2	B86	C	142	and valet, Mr. Victor Giglio	24	Paris, France	Cherbourg	New York, New York, US	\N	\N	1
141	0	3	Boulos, Mrs. Joseph (Sultana)	female	\N	0	2	2678	15.2458	\N	C	696	Bulus, Mrs. Sultanah (née Rizq)	40	Unknown, Lebanon	Cherbourg	Kent, British Columbia, Canada	\N	\N	3
142	1	3	Nysten, Miss. Anna Sofia	female	22	0	0	347081	7.75	\N	S	1077	Nysten, Miss Anna Sofia	22	Kisa, Östergötland, Sweden	Southampton	Hackensack, New Jersey, US	13	\N	3
143	1	3	Hakkarainen, Mrs. Pekka Pietari (Elin Matilda Dolck)	female	24	1	0	STON/O2. 3101279	15.85	\N	S	850	Hakkarainen, Mrs. Elin Matilda (née Dolck)	24	Helsinki, Finland	Southampton	Monessen, Pennsylvania, US	15	\N	3
144	0	3	Burke, Mr. Jeremiah	male	19	0	0	365222	6.75	\N	Q	699	Burke, Mr. Jeremiah	19	Glanmire, Cork, Ireland	Queenstown	Charlestown, US	\N	\N	3
145	0	2	Andrew, Mr. Edgardo Samuel	male	18	0	0	231945	11.5	\N	S	329	Andrew, Mr. Edgar Samuel	17	San Ambrosio, Córdoba, Argentina	Southampton	Trenton, New Jersey, US	\N	\N	2
146	0	2	Nicholls, Mr. Joseph Charles	male	19	1	1	C.A. 33112	36.75	\N	S	525	Nicholls, Mr. Joseph Charles "Joe"	19	St. Ives, Cornwall, England	Southampton	Houghton, Michigan, US	\N	101MB	2
147	1	3	Andersson, Mr. August Edvard ("Wennerstrom")	male	27	0	0	350043	7.7958	\N	S	1293	Wennerström, Mr. August Edvard Andersson	27	Malmö, Skåne, Sweden	Southampton	Chicago, Illinois, US	A	\N	3
148	0	3	Ford, Miss. Robina Maggie "Ruby"	female	9	2	2	W./C. 6608	34.375	\N	S	818	Ford, Miss Robina Maggie	7	Rotherfield, East Sussex, England	Southampton	Essex County, New Jersey, US	\N	\N	3
149	0	2	Navratil, Mr. Michel ("Louis M Hoffman")	male	36.5	0	2	230080	26	F2	S	521	Navratil, Mr. Michel (alias Louis M. Hoffman)	32	Nice, France	Southampton	New York City	\N	15MB	2
150	0	2	Byles, Rev. Thomas Roussel Davids	male	42	0	0	244310	13	\N	S	362	Byles, Father Thomas Roussel Davids	42	London, England	Southampton	Jacksonville, Florida, US	\N	\N	2
151	0	2	Bateman, Rev. Robert James	male	51	0	0	S.O.P. 1166	12.525	\N	S	338	Bateman, Reverend Robert James	51	Jacksonville, Florida, US	Southampton	Jacksonville, Florida, US	\N	174MB	2
152	1	1	Pears, Mrs. Thomas (Edith Wearne)	female	22	1	0	113776	66.6	C2	S	226	Pears, Mrs. Edith (née Wearne)	22	Isleworth, London, England, UK	Southampton	New York, New York, US	8	\N	1
153	0	3	Meo, Mr. Alfonzo	male	55.5	0	0	A.5. 11206	8.05	\N	S	1024	Meo-Martino, Mr. Alfonzo	48	Bournemouth, Dorset, England	Southampton	Washington, DC, US	\N	201MB	3
154	0	3	van Billiard, Mr. Austin Blyler	male	40.5	0	2	A/5. 851	14.5	\N	S	1269	Van Billiard, Mr. Austin Blyler	35	London, England	Southampton	North Wales, Pennsylvania, US	\N	255MB	3
155	0	3	Olsen, Mr. Ole Martin	male	\N	0	0	Fa 265302	7.3125	\N	S	1095	Olsen, Mr. Ole Martin	27	Sunnhordland, Norway	Southampton	Broderick, Canada	\N	\N	3
156	0	1	Williams, Mr. Charles Duane	male	51	0	1	PC 17597	61.3792	\N	C	322	Williams, Mr. Charles Duane	51	Geneva, Switzerland	Cherbourg	Radnor, Pennsylvania, US	\N	\N	1
157	1	3	Gilnagh, Miss. Katherine "Katie"	female	16	0	0	35851	7.7333	\N	Q	825	Gilnagh, Miss Mary Katherine "Katie"	17	Esker, Longford, Ireland	Queenstown	New York City	16	\N	3
158	0	3	Corn, Mr. Harry	male	30	0	0	SOTON/OQ 392090	8.05	\N	S	740	Corn, Mr. Henry "Harry"	30	London, England	Southampton	New York City	\N	\N	3
159	0	3	Smiljanic, Mr. Mile	male	\N	0	0	315037	8.6625	\N	S	1222	Smiljanić, Mr. Jakob Mile	37	Pisac, Croatia	Southampton	New York City	\N	\N	3
160	0	3	Sage, Master. Thomas Henry	male	\N	8	2	CA. 2343	69.55	\N	S	1184	Sage, Master Thomas Henry	4	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
161	0	3	Cribb, Mr. John Hatfield	male	44	0	1	371362	16.1	\N	S	747	Cribb, Mr. John Hatfield	44	Bournemouth, Dorset, England	Southampton	Newark, New Jersey, US	\N	\N	3
162	1	2	Watt, Mrs. James (Elizabeth "Bessie" Inglis Milne)	female	40	0	0	C.A. 33595	15.75	\N	S	588	Watt, Mrs. Elizabeth Inglis "Bessie" (née Milne)	40	Aberdeen, Aberdeenshire, Scotland	Southampton	Portland, Oregon, US	9	\N	2
163	0	3	Bengtsson, Mr. John Viktor	male	26	0	0	347068	7.775	\N	S	678	Bengtsson, Mr. Johan Viktor	26	Fridhemsberg, Halland, Sweden	Southampton	Monee, Illinois, US	\N	\N	3
164	0	3	Calic, Mr. Jovo	male	17	0	0	315093	8.6625	\N	S	708	Čalić, Mr. Jovo	17	Brezik, Croatia	Southampton	Sault Ste. Marie, Michigan, US	\N	\N	3
165	0	3	Panula, Master. Eino Viljami	male	1	4	1	3101295	39.6875	\N	S	1114	Panula, Master Eino Viljami	1	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
166	1	3	Goldsmith, Master. Frank John William "Frankie"	male	9	0	2	363291	20.525	\N	S	829	Goldsmith, Master Frank John William	9	Strood, Kent, England	Southampton	Detroit, Michigan, US	C	\N	3
167	1	1	Chibnall, Mrs. (Edith Martha Bowerman)	female	\N	0	1	113505	55	E33	S	75	Chibnall, Mrs. Edith Martha Bowerman (née Barber)	48	St Leonards-on-Sea, East Sussex, England, UK	Southampton	New York, New York, US	6	\N	1
168	0	3	Skoog, Mrs. William (Anna Bernhardina Karlsson)	female	45	1	4	347088	27.9	\N	S	1215	Skoog, Mrs. Anna Bernhardina (née Karlsson)	43	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
169	0	1	Baumann, Mr. John D	male	\N	0	0	PC 17318	25.925	\N	S	22	Baumann, Mr. John D.	60	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
170	0	3	Ling, Mr. Lee	male	28	0	0	1601	56.4958	\N	S	979	Ling, Mr. Lee	24	Hong Kong, China	Southampton	New York City	\N	\N	3
171	0	1	Van der hoef, Mr. Wyckoff	male	61	0	0	111240	33.5	B19	S	303	Van der Hoef, Mr. Wyckoff	61	Brooklyn, New York, US	Belfast	Brooklyn, New York, US	\N	245MB	1
172	0	3	Rice, Master. Arthur	male	4	4	1	382652	29.125	\N	Q	1150	Rice, Master Arthur	4	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	\N	3
173	1	3	Johnson, Miss. Eleanor Ileen	female	1	1	1	347742	11.1333	\N	S	904	Johnson, Miss Eleanor Ileen	1	St. Charles, Illinois, US	Southampton	St. Charles, Illinois, US	15	\N	3
174	0	3	Sivola, Mr. Antti Wilhelm	male	21	0	0	STON/O 2. 3101280	7.925	\N	S	1212	Sivola, Mr. Antti Vilhelmi	21	Mountain Home, Idaho, US	Southampton	Mountain Home, Idaho, US	\N	\N	3
175	0	1	Smith, Mr. James Clinch	male	56	0	0	17764	30.6958	A7	C	263	Smith, Mr. James Clinch	56	Paris, France	Cherbourg	Long Island, New York, US	\N	\N	1
176	0	3	Klasen, Mr. Klas Albin	male	18	1	1	350404	7.8542	\N	S	944	Klasén, Mr. Klas Albin	18	Grimshut, Småland, Sweden	Southampton	New York City	\N	\N	3
177	0	3	Lefebre, Master. Henry Forbes	male	\N	3	1	4133	25.4667	\N	S	965	Lefebvre, Master Henri Franck-Marie-Joseph	5	Liévin, Pas-de-Calais, France	Southampton	Mystic, Iowa, US	\N	\N	3
178	0	1	Isham, Miss. Ann Elizabeth	female	50	0	0	PC 17595	28.7125	C49	C	169	Isham, Miss Ann Elizabeth	50	Chicago, Illinois, US	Cherbourg	Chicago, Illinois, US	\N	\N	1
179	0	2	Hale, Mr. Reginald	male	30	0	0	250653	13	\N	S	430	Hale, Mr. Reginald	30	Auburn, New York, US	Southampton	Auburn, New York, US	\N	75MB	2
180	0	3	Leonard, Mr. Lionel	male	36	0	0	LINE	0	\N	S	970	Leonard, Mr. Lionel	36	New York City, New York, US	Southampton	New York City	\N	\N	3
181	0	3	Sage, Miss. Constance Gladys	female	\N	8	2	CA. 2343	69.55	\N	S	1183	Sage, Miss Constance Gladys	7	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
182	0	2	Pernot, Mr. Rene	male	\N	0	0	SC/PARIS 2131	15.05	\N	C	143	and chauffeur, Mr. René Pernot[59]	39	Paris, France	Cherbourg	New York, New York, US	\N	\N	1
183	0	3	Asplund, Master. Clarence Gustaf Hugo	male	9	4	2	347077	31.3875	\N	S	651	Asplund, Master Clarence Gustaf Hugo	9	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	\N	\N	3
184	1	2	Becker, Master. Richard F	male	1	2	1	230136	39	F4	S	345	Becker, Master Richard Frederick	1	Guntur, Madras Province, British India	Southampton	Benton Harbor, Michigan, US	11	\N	2
185	1	3	Kink-Heilmann, Miss. Luise Gretchen	female	4	0	2	315153	22.025	\N	S	940	Kink, Miss Luise Gretchen	4	Zürich, Switzerland	Southampton	Milwaukee, Wisconsin, US	2	\N	3
186	0	1	Rood, Mr. Hugh Roscoe	male	\N	0	0	113767	50	A32	S	239	Rood, Mr. Hugh Roscoe	38	Seattle, Washington, US	Southampton	Seattle, Washington, US	\N	\N	1
187	1	3	O'Brien, Mrs. Thomas (Johanna "Hannah" Godfrey)	female	\N	1	0	370365	15.5	\N	Q	1080	O'Brien, Mrs. Johanna "Hannah" (née Godfrey)	26	Pallasgreen, Limerick, Ireland	Queenstown	New York City	?	\N	3
188	1	1	Romaine, Mr. Charles Hallace ("Mr C Rolmane")	male	45	0	0	111428	26.55	\N	S	238	Romaine, Mr. Charles Hallance (alias C. Rolmane)	45	New York, New York, US	Southampton	New York, New York, US	9	\N	1
189	0	3	Bourke, Mr. John	male	40	1	1	364849	15.5	\N	Q	684	Bourke, Mr. John	42	Carrowskehine, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
190	0	3	Turcin, Mr. Stjepan	male	36	0	0	349247	7.8958	\N	S	1266	Turčin, Mr. Stjepan	36	Bratina, Croatia	Southampton	Youngstown, Ohio, US	\N	\N	3
191	1	2	Pinsky, Mrs. (Rosa)	female	32	0	0	234604	13	\N	S	541	Pinsky, Mrs. Rosa	21	Brooklyn, New York, US	Southampton	Brooklyn, New York, US	9	\N	2
192	0	2	Carbines, Mr. William	male	19	0	0	28424	13	\N	S	369	Carbines, Mr. William	19	St. Ives, Cornwall, England	Southampton	Houghton, Michigan, US	\N	18MB	2
193	1	3	Andersen-Jensen, Miss. Carla Christine Nielsine	female	19	1	0	350046	7.8542	\N	S	631	Andersen-Jensen, Miss Carla Christine	19	Eskilstrup, Denmark	Southampton	Portland, Oregon, US	16	\N	3
195	1	1	Brown, Mrs. James Joseph (Margaret Tobin)	female	44	0	0	PC 17610	27.7208	B4	C	44	Brown, Mrs. Margaret (née Tobin)	44	Denver, Colorado, US	Cherbourg	Denver, Colorado, US	6	\N	1
196	1	1	Lurette, Miss. Elise	female	58	0	0	PC 17569	146.5208	B80	C	276	and maid, Miss Eugenie Elise Lurette	59	New York, New York, US	Cherbourg	New York, New York, US	6	\N	1
197	0	3	Mernagh, Mr. Robert	male	\N	0	0	368703	7.75	\N	Q	1025	Mernagh, Mr. John Robert	26	Ballywilliam, Wexford, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
198	0	3	Olsen, Mr. Karl Siegwart Andreas	male	42	0	1	4579	8.4042	\N	S	1093	Olsen, Mr. Karl Siegwart Andreas	42	Trondheim, Norway	Southampton	Brooklyn, New York, US	\N	\N	3
199	1	3	Madigan, Miss. Margaret "Maggie"	female	\N	0	0	370370	7.75	\N	Q	992	Madigan, Miss Margaret "Maggie"	21	Askeaton, Limerick, Ireland	Queenstown	New York City	15	\N	3
200	0	2	Yrois, Miss. Henriette ("Mrs Harbeck")	female	24	0	0	248747	13	\N	S	607	Yvois, Miss Henriette	24	Paris, France	Southampton	Montreal, Quebec, Canada	\N	\N	2
201	0	3	Vande Walle, Mr. Nestor Cyriel	male	28	0	0	345770	9.5	\N	S	1283	Van de Walle, Mr. Nestor Cyriel	28	Westrozebeke, Belgium	Southampton	New York City	\N	\N	3
202	0	3	Sage, Mr. Frederick	male	\N	8	2	CA. 2343	69.55	\N	S	1179	Sage, Mr. Frederick	16	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
203	0	3	Johanson, Mr. Jakob Alfred	male	34	0	0	3101264	6.4958	\N	S	895	Johanson, Mr. Jakob Alfred	34	Munsala, Finland	Southampton	Vancouver, British Columbia, Canada	\N	143MB	3
204	0	3	Youseff, Mr. Gerious	male	45.5	0	0	2628	7.225	\N	C	1310	Youssef, Mr. Gerios (Sam'aan)	45	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	\N	\N	3
205	1	3	Cohen, Mr. Gurshon "Gus"	male	18	0	0	A/5 3540	8.05	\N	S	727	Cohen, Mr. Gershon "Gus"	18	London, England	Southampton	Brooklyn, New York, US	12	\N	3
206	0	3	Strom, Miss. Telma Matilda	female	2	0	1	347054	10.4625	G6	S	1239	Ström, Miss Thelma Matilda Wilhelmina	2	Indiana Harbor, Indiana, US	Southampton	Indiana Harbor, Indiana, US	\N	\N	3
207	0	3	Backstrom, Mr. Karl Alfred	male	32	1	0	3101278	15.85	\N	S	663	Backström, Mr. Karl Alfred	32	Kotka, Finland	Southampton	New York City	\N	\N	3
208	1	3	Albimona, Mr. Nassef Cassem	male	26	0	0	2699	18.7875	\N	C	622	Al-Muna, Mr. Nasif Qasim	26	Fredericksburg, Virginia, US	Cherbourg	Fredericksburg, Virginia, US	15	\N	3
209	1	3	Carr, Miss. Helen "Ellen"	female	16	0	0	367231	7.75	\N	Q	741	Corr, Miss Helen	16	Corglass, Longford, Ireland	Queenstown	New York City	16	\N	3
210	1	1	Blank, Mr. Henry	male	40	0	0	112277	31	A31	C	34	Blank, Mr. Henry	39	Glen Ridge, New Jersey, US	Cherbourg	Glen Ridge, New Jersey, US	7	\N	1
211	0	3	Ali, Mr. Ahmed	male	24	0	0	SOTON/O.Q. 3101311	7.05	\N	S	625	Ali, Mr. Ahmed	24	Buenos Aires, Argentina	Southampton	New York City	\N	\N	3
212	1	2	Cameron, Miss. Clear Annie	female	35	0	0	F.C.C. 13528	21	\N	S	367	Cameron, Miss Clear Annie	35	London, England, UK	Southampton	Mamaronek, New York, US	14	\N	2
213	0	3	Perkin, Mr. John Henry	male	22	0	0	A/5 21174	7.25	\N	S	1126	Perkin, Mr. John Henry	22	Holsworthy, Devon, England	Southampton	Saskatoon, Saskatchewan, Canada	\N	\N	3
214	0	2	Givard, Mr. Hans Kristensen	male	30	0	0	250646	13	\N	S	428	Givard, Mr. Hans Kristensen	30	Kølsen, Vorde Sogn, Denmark	Southampton	San Francisco, California, US	\N	305MB	2
215	0	3	Kiernan, Mr. Philip	male	\N	1	0	367229	7.75	\N	Q	936	Kiernan, Mr. Philip	22	Aughnacliffe, Longford, Ireland	Queenstown	Jersey City, New Jersey, US	\N	\N	3
216	1	1	Newell, Miss. Madeleine	female	31	1	0	35273	113.275	D36	C	214	Newell, Miss Madeleine	31	Lexington, Massachusetts, US	Cherbourg	Lexington, Massachusetts, US	6	\N	1
217	1	3	Honkanen, Miss. Eliina	female	27	0	0	STON/O2. 3101283	7.925	\N	S	875	Honkanen, Miss Eliina	27	Saarijärvi, Finland	Southampton	New York City	?	\N	3
218	0	2	Jacobsohn, Mr. Sidney Samuel	male	42	1	0	243847	27	\N	S	465	Jacobsohn, Mr. Sidney Samuel	40	London, England	Southampton	Montreal, Quebec, Canada	\N	\N	2
219	1	1	Bazzani, Miss. Albina	female	32	0	0	11813	76.2917	D15	C	46	and maid, Miss Albina Bazzani	36	Philadelphia, Pennsylvania, US	Cherbourg	Philadelphia, Pennsylvania, US	8	\N	1
220	0	2	Harris, Mr. Walter	male	30	0	0	W/C 14208	10.5	\N	S	437	Harris, Mr. Walter	30	London, England	Southampton	New York City	\N	\N	2
221	1	3	Sunderland, Mr. Victor Francis	male	16	0	0	SOTON/OQ 392089	8.05	\N	S	1240	Sunderland, Mr. Victor Francis	20	London, England	Southampton	Cleveland, Ohio, US	B	\N	3
222	0	2	Bracken, Mr. James H	male	27	0	0	220367	13	\N	S	351	Bracken, Mr. James H.	29	Lake Arthur, New Mexico, US	Southampton	Lake Arthur, New Mexico, US	\N	\N	2
223	0	3	Green, Mr. George Henry	male	51	0	0	21440	8.05	\N	S	839	Green, Mr. George Henry	40	Dorking, Surrey, England	Southampton	Lead, South Dakota, US	\N	\N	3
224	0	3	Nenkoff, Mr. Christo	male	\N	0	0	349234	7.8958	\N	S	1065	Nenkoff, Mr. Christo	22	Unknown, Bulgaria	Southampton	Coon Rapids, Iowa, US	\N	\N	3
225	1	1	Hoyt, Mr. Frederick Maxfield	male	38	1	0	19943	90	C93	S	166	Hoyt, Mr. Frederick Maxfield	35	New York, New York, US	Southampton	Stamford, Connecticut, US	D	\N	1
226	0	3	Berglund, Mr. Karl Ivar Sven	male	22	0	0	PP 4348	9.35	\N	S	679	Berglund, Mr. Karl Ivar Sven	22	Firtby, Finland	Southampton	New York City	\N	\N	3
227	1	2	Mellors, Mr. William John	male	19	0	0	SW/PP 751	10.5	\N	S	510	Mellors, Mr. William John	19	Chelsea, London, England	Southampton	Long Island, New York, US	B	\N	2
228	0	3	Lovell, Mr. John Hall ("Henry")	male	20.5	0	0	A/5 21173	7.25	\N	S	985	Lovell, Mr. John Hall ("Henry")	20	Northlew, Devon, England	Southampton	New York City	\N	\N	3
229	0	2	Fahlstrom, Mr. Arne Jonas	male	18	0	0	236171	13	\N	S	410	Fahlstrøm, Mr. Arne Joma	18	Oslo, Norway	Southampton	Bayonne, New Jersey, US	\N	\N	2
230	0	3	Lefebre, Miss. Mathilde	female	\N	3	1	4133	25.4667	\N	S	963	Lefebvre, Miss Mathilde Franck-Marie-Joseph	12	Liévin, Pas-de-Calais, France	Southampton	Mystic, Iowa, US	\N	\N	3
231	1	1	Harris, Mrs. Henry Birkhardt (Irene Wallach)	female	35	1	0	36973	83.475	C83	S	150	Harris, Mrs. Irene (née Wallach)	35	New York, New York, US	Southampton	New York, New York, US	D	\N	1
232	0	3	Larsson, Mr. Bengt Edvin	male	29	0	0	347067	7.775	\N	S	958	Larsson, Mr. Bengt Edvin	29	Nyköping, Södermanland, Sweden	Southampton	Hartford, Connecticut, US	\N	\N	3
233	0	2	Sjostedt, Mr. Ernst Adolf	male	59	0	0	237442	13.5	\N	S	567	Sjöstedt, Mr. Ernst Adolf	30	Hjo, Västergötland, Sweden	Southampton	Sault Ste Marie, Michigan, US	10	\N	2
234	1	3	Asplund, Miss. Lillian Gertrud	female	5	4	2	347077	31.3875	\N	S	653	Asplund, Miss Lillian Gertrud	5	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	15	\N	3
235	0	2	Leyson, Mr. Robert William Norman	male	24	0	0	C.A. 29566	10.5	\N	S	493	Leyson, Mr. Robert William Norman	25	London, England	Southampton	New York City	\N	108MB	2
236	0	3	Harknett, Miss. Alice Phoebe	female	\N	0	0	W./C. 6609	7.55	\N	S	860	Harknett, Miss Alice Phoebe	21	Thornton Heath, London, England	Southampton	New London, Connecticut, US	\N	\N	3
237	0	2	Hold, Mr. Stephen	male	44	1	0	26707	26	\N	S	456	Hold, Mr. Stephen	44	Porthoustock, Cornwall, England	Southampton	Sacramento, California, US	\N	\N	2
238	1	2	Collyer, Miss. Marjorie "Lottie"	female	8	0	2	C.A. 31921	26.25	\N	S	385	Collyer, Miss Marjorie Charlotte "Lottie"	8	Bishopstoke, Hampshire, England	Southampton	Payette, Idaho, US	14	\N	2
239	0	2	Pengelly, Mr. Frederick William	male	19	0	0	28665	10.5	\N	S	536	Pengelly, Mr. Frederick William	19	Gunnislake, Cornwall, England	Southampton	Butte, Montana, US	\N	\N	2
240	0	2	Hunt, Mr. George Henry	male	33	0	0	SCO/W 1585	12.275	\N	S	463	Hunt, Mr. George Henry	33	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	\N	\N	2
241	0	3	Zabour, Miss. Thamine	female	\N	1	0	2665	14.4542	\N	C	885	Jabbour, Miss Tamini	19	Unknown, Syria	Cherbourg	New York City	\N	\N	3
242	1	3	Murphy, Miss. Katherine "Kate"	female	\N	1	0	367230	15.5	\N	Q	1050	Murphy, Miss Catherine "Kate"	18	Aghnacliffe, Longford, Ireland	Queenstown	Philadelphia, Pennsylvania, US	16	\N	3
243	0	2	Coleridge, Mr. Reginald Charles	male	29	0	0	W./C. 14263	10.5	\N	S	380	Coleridge, Mr. Reginald Charles	29	London, England	Southampton	Detroit, Michigan, US	\N	\N	2
244	0	3	Maenpaa, Mr. Matti Alexanteri	male	22	0	0	STON/O 2. 3101275	7.125	\N	S	994	Mäenpää, Mr. Matti Alexanteri	22	Kauhajoki, Finland	Southampton	Sudbury, Ontario, Canada	\N	\N	3
245	0	3	Attalah, Mr. Sleiman	male	30	0	0	2694	7.225	\N	C	658	Attala, Mr. Sleiman	30	Ottawa, Ontario, Canada	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
246	0	1	Minahan, Dr. William Edward	male	44	2	0	19928	90	C78	Q	205	Minahan, Dr. William Edward	44	Fond du Lac, Wisconsin, US	Southampton	Fond du Lac, Wisconsin, US	\N	230MB	1
247	0	3	Lindahl, Miss. Agda Thorilda Viktoria	female	25	0	0	347071	7.775	\N	S	973	Lindahl, Miss Agda Thorilda Viktoria	25	Stockholm, Sweden	Southampton	Saranac Lake, New York, US	\N	\N	3
248	1	2	Hamalainen, Mrs. William (Anna)	female	24	0	2	250649	14.5	\N	S	431	Hämäläinen, Mrs. Anna (Anna Hamlin)	24	Detroit, Michigan, US	Southampton	Detroit, Michigan, US	4	\N	2
249	1	1	Beckwith, Mr. Richard Leonard	male	37	1	1	11751	52.5542	D35	S	26	Beckwith, Mr. Richard Leonard	37	New York, New York, US	Southampton	New York, New York, US	5	\N	1
250	0	2	Carter, Rev. Ernest Courtenay	male	54	1	0	244252	26	\N	S	370	Carter, Father Ernest Courtenay	54	London, England, UK	Southampton	New York City	\N	\N	2
251	0	3	Reed, Mr. James George	male	\N	0	0	362316	7.25	\N	S	1143	Reed, Mr. James George	19	Penarth, Glamorgan, Wales	Southampton	New York City	\N	\N	3
252	0	3	Strom, Mrs. Wilhelm (Elna Matilda Persson)	female	29	1	1	347054	10.4625	G6	S	1238	Ström, Mrs. Elna Matilda (née Persson)	29	Indiana Harbor, Indiana, US	Southampton	Indiana Harbor, Indiana, US	\N	\N	3
253	0	1	Stead, Mr. William Thomas	male	62	0	0	113514	26.55	C87	S	278	Stead, Mr. William Thomas	62	London, England, UK	Southampton	New York, New York, US	\N	\N	1
254	0	3	Lobb, Mr. William Arthur	male	30	1	0	A/5. 3336	16.1	\N	S	982	Lobb, Mr. William Arthur	30	Scranton, Pennsylvania, US	Southampton	Scranton, Pennsylvania, US	\N	\N	3
255	0	3	Rosblom, Mrs. Viktor (Helena Wilhelmina)	female	41	0	2	370129	20.2125	\N	S	1161	Rosblom, Mrs. Helena Wilhelmina	41	Suistamo, Finland	Southampton	Astoria, Oregon, US	\N	\N	3
256	1	3	Touma, Mrs. Darwis (Hanne Youssef Razi)	female	29	0	2	2650	15.2458	\N	C	1263	Touma, Mrs. Hanna Youssef (née Razi)	27	Tibnin, Lebanon	Cherbourg	Dowagiac, Michigan, US	C	\N	3
257	1	1	Thorne, Mrs. Gertrude Maybelle	female	\N	0	0	PC 17585	79.2	\N	C	300	Thorne, Mrs. Gertrude Maybelle (née McMinn)	37	New York, New York, US	Cherbourg	New York, New York, US	D	\N	1
258	1	1	Cherry, Miss. Gladys	female	30	0	0	110152	86.5	B77	S	73	Cherry, Miss Gladys	30	London, England, UK	Southampton	Vancouver, British Columbia, Canada	8	\N	1
259	1	1	Ward, Miss. Anna	female	35	0	0	PC 17755	512.3292	\N	C	51	and maid, Miss Annie Moore Ward	38	Germantown, Pennsylvania, US	Cherbourg	Germantown, Pennsylvania, US	3	\N	1
260	1	2	Parrish, Mrs. (Lutie Davis)	female	50	0	1	230433	26	\N	S	535	Parrish, Mrs. Lutie Davis (née Temple)	60	Woodford County, Kentucky, US	Southampton	Woodford County, Kentucky, US	12	\N	2
261	0	3	Smith, Mr. Thomas	male	\N	0	0	384461	7.75	\N	Q	1223	Smyth, Mr. Thomas	26	Caltra, Galway, Ireland	Queenstown	Hammond, Indiana, US	\N	\N	3
262	1	3	Asplund, Master. Edvin Rojj Felix	male	3	4	2	347077	31.3875	\N	S	654	Asplund, Master Edvin Rojj Felix	3	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	15	\N	3
263	0	1	Taussig, Mr. Emil	male	52	1	1	110413	79.65	E67	S	291	Taussig, Mr. Emil	52	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
264	0	1	Harrison, Mr. William	male	40	0	0	112059	0	B94	S	172	and secretary, Mr. William Henry Harrison	45	Wallasey, Merseyside, England, UK	Southampton	New York, New York, US	\N	110MB	1
265	0	3	Henry, Miss. Delia	female	\N	0	0	382649	7.75	\N	Q	870	Henry, Miss Bridget Delia	23	Clonown, Roscommon, Ireland	Queenstown	Boston, Massachusetts, US	\N	\N	3
266	0	2	Reeves, Mr. David	male	36	0	0	C.A. 17248	10.5	\N	S	548	Reeves, Mr. David	36	Slinfold, West Sussex, England	Southampton	New York City	\N	\N	2
267	0	3	Panula, Mr. Ernesti Arvid	male	16	4	1	3101295	39.6875	\N	S	1110	Panula, Mr. Ernesti Arvid	16	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
268	1	3	Persson, Mr. Ernst Ulrik	male	25	1	0	347083	7.775	\N	S	1127	Persson, Mr. Ernst Ulrik	25	Stockholm, Uppland, Sweden	Southampton	Indianapolis, Indiana, US	15	\N	3
269	1	1	Graham, Mrs. William Thompson (Edith Junkins)	female	58	0	1	PC 17582	153.4625	C125	S	136	Graham, Mrs. Edith Ware (née Junkins)	59	Greenwich, Connecticut, US	Southampton	Greenwich, Connecticut, US	3	\N	1
270	1	1	Bissette, Miss. Amelia	female	35	0	0	PC 17760	135.6333	C99	S	311	and maid, Miss Amelia Mayo "Nellie" Bessette	39	New York, New York, US	Cherbourg	New York, New York, US	8	\N	1
271	0	1	Cairns, Mr. Alexander	male	\N	0	0	113798	31	\N	S	58	and valet, Mr. Alexander Cairns	28	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	\N	\N	1
272	1	3	Tornquist, Mr. William Henry	male	25	0	0	LINE	0	\N	S	1262	Törnquist, Mr. William Henry	25	Sundbyberg, Sweden	Southampton	New York City	15	\N	3
273	1	2	Mellinger, Mrs. (Elizabeth Anne Maidment)	female	41	0	1	250644	19.5	\N	S	508	Mellinger, Mrs. Elizabeth Anne (née Maidment)	41	Wimbledon, London, England	Southampton	Bennington, Vermont, US	14	\N	2
274	0	1	Natsch, Mr. Charles H	male	37	0	1	PC 17596	29.7	C118	C	212	Natsch, Mr. Charles	36	Brooklyn, New York, US	Cherbourg	Brooklyn, New York, US	\N	\N	1
275	1	3	Healy, Miss. Hanora "Nora"	female	\N	0	0	370375	7.75	\N	Q	862	Healy, Miss Hanora (Nora)	29	Athenry, Galway, Ireland	Queenstown	New York City	16	\N	3
276	1	1	Andrews, Miss. Kornelia Theodosia	female	63	1	0	13502	77.9583	D7	S	11	Andrews, Miss Kornelia Theodosia	62	Hudson, New York, US	Cherbourg	Hudson, New York, US	10	\N	1
277	0	3	Lindblom, Miss. Augusta Charlotta	female	45	0	0	347073	7.75	\N	S	974	Lindblom, Miss Augusta Charlotta	45	Stockholm, Sweden	Southampton	Stratford, Connecticut, US	\N	\N	3
278	0	2	Parkes, Mr. Francis "Frank"	male	\N	0	0	239853	0	\N	S	534	Parkes, Mr. Francis "Frank"[60]	18	Belfast, Ireland	Belfast	New York City	\N	\N	2
279	0	3	Rice, Master. Eric	male	7	4	1	382652	29.125	\N	Q	1149	Rice, Master Frederick Thomas "Eric"	7	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	\N	3
280	1	3	Abbott, Mrs. Stanton (Rosa Hunt)	female	35	1	1	C.A. 2673	20.25	\N	S	609	Abbott, Mrs. Rhoda Mary (née Hunt)	39	East Providence, Rhode Island, US	Southampton	East Providence, Rhode Island, US	A	\N	3
281	0	3	Duane, Mr. Frank	male	65	0	0	336439	7.75	\N	Q	791	Dwan, Mr. Frank	65	Bunmahon, Waterford, Ireland	Queenstown	Morris Plains, New Jersey, US	\N	\N	3
282	0	3	Olsson, Mr. Nils Johan Goransson	male	28	0	0	347464	7.8542	\N	S	1097	Olsson, Mr. Nils Johan Göransson	28	Eslöv, Skåne, Sweden	Southampton	New York City	\N	\N	3
283	0	3	de Pelsmaeker, Mr. Alfons	male	16	0	0	345778	9.5	\N	S	769	de Pelsmaeker, Mr. Alfons	16	Heldergem, Haaltert, East Flanders, Belgium	Southampton	Gladstone, Michigan, US	\N	\N	3
284	1	3	Dorking, Mr. Edward Arthur	male	19	0	0	A/5. 10482	8.05	\N	S	784	Dorking, Mr. Edward Arthur	18	Liss, Hampshire, England	Southampton	Oglesby, Illinois, US	B	\N	3
285	0	1	Smith, Mr. Richard William	male	\N	0	0	113056	26	A19	S	266	Smith, Mr. Richard William	57	Streatham, London, England, UK	Southampton	New York, New York, US	\N	\N	1
286	0	3	Stankovic, Mr. Ivan	male	33	0	0	349239	8.6625	\N	C	1230	Stanković, Mr. Ivan	33	Galdovo, Croatia	Cherbourg	New York City	\N	\N	3
287	1	3	de Mulder, Mr. Theodore	male	30	0	0	345774	9.5	\N	S	768	de Mulder, Mr. Theodoor	36	Aspelare, East Flanders, Belgium	Southampton	Detroit, Michigan, US	11	\N	3
288	0	3	Naidenoff, Mr. Penko	male	22	0	0	349206	7.8958	\N	S	1058	Naidenoff, Mr. Penko	22	Gumostnik, Lovech, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
289	1	2	Hosono, Mr. Masabumi	male	42	0	0	237798	13	\N	S	459	Hosono, Mr. Masabumi	41	Tokyo, Japan	Southampton	Tokyo, Japan	10	\N	2
290	1	3	Connolly, Miss. Kate	female	22	0	0	370373	7.75	\N	Q	734	Connolly, Miss Katherine "Kate"	22	Cortrasna, Cavan, Ireland	Queenstown	New York City	13	\N	3
291	1	1	Barber, Miss. Ellen "Nellie"	female	26	0	0	19877	78.85	\N	S	68	and maid, Miss Ellen "Nellie" Barber	26	London, England, UK	Southampton	New York, New York, US	6	\N	1
292	1	1	Bishop, Mrs. Dickinson H (Helen Walton)	female	19	1	0	11967	91.0792	B49	C	31	Bishop, Mrs. Helen (née Walton)[62][65]	19	Dowagiac, Michigan, US	Cherbourg	Dowagiac, Michigan, US	7	\N	1
293	0	2	Levy, Mr. Rene Jacques	male	36	0	0	SC/Paris 2163	12.875	D	C	492	Levy, Mr. René Jacques	36	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	\N	\N	2
294	0	3	Haas, Miss. Aloisia	female	24	0	0	349236	8.85	\N	S	846	Haas, Miss Aloisia	24	Altdorf, Uri, Switzerland	Southampton	Chicago, Illinois, US	\N	\N	3
295	0	3	Mineff, Mr. Ivan	male	24	0	0	349233	7.8958	\N	S	1029	Mineff, Mr. Ivan	24	Unknown, Bulgaria	Southampton	Coon Rapids, Iowa, US	\N	\N	3
296	0	1	Lewy, Mr. Ervin G	male	\N	0	0	PC 17612	27.7208	\N	C	185	Lewy, Mr. Ervin G.	31	Chicago, Illinois, US	Cherbourg	Chicago, Illinois, US	\N	\N	1
297	0	3	Hanna, Mr. Mansour	male	23.5	0	0	2693	7.2292	\N	C	854	Hanna, Mr. Mansur	35	Kfar Mechi, Syria	Cherbourg	Ottawa, Ontario, Canada	\N	188MB	3
298	0	1	Allison, Miss. Helen Loraine	female	2	1	2	113781	151.55	C22 C26	S	7	Allison, Miss Helen Loraine	2	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	\N	1
299	1	1	Saalfeld, Mr. Adolphe	male	\N	0	0	19988	30.5	C106	S	253	Saalfeld, Mr. Adolphe	47	Manchester, England, UK	Southampton	New York, New York, US	3	\N	1
300	1	1	Baxter, Mrs. James (Helene DeLaudeniere Chaput)	female	50	0	1	PC 17558	247.5208	B58 B60	C	23	Baxter, Mrs. Hélène (née de Lanaudière-Chaput)	50	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	6	\N	1
301	1	3	Kelly, Miss. Anna Katherine "Annie Kate"	female	\N	0	0	9234	7.75	\N	Q	930	Kelly, Miss Anna Katherine	20	Cuilmullagh, Mayo, Ireland	Queenstown	Chicago, Illinois, US	16	\N	3
302	1	3	McCoy, Mr. Bernard	male	\N	2	0	367226	23.25	\N	Q	1010	McCoy, Mr. Bernard	24	Carrickatane, Tyrone, Ireland	Queenstown	Brooklyn, New York, US	16	\N	3
303	0	3	Johnson, Mr. William Cahoone Jr	male	19	0	0	LINE	0	\N	S	906	Johnson, Mr. William Cahoone Jr.	19	Hawthorne, New Jersey, US	Southampton	New York City	\N	\N	3
304	1	2	Keane, Miss. Nora A	female	\N	0	0	226593	12.35	E101	Q	476	Keane, Miss Nora Agnes	46	Castleconnell, Limerick, Ireland[note 1]	Queenstown	Harrisburg, Pennsylvania, US	10	\N	2
305	0	3	Williams, Mr. Howard Hugh "Harry"	male	\N	0	0	A/5 2466	8.05	\N	S	1300	Williams, Mr. Howard Hugh "Harry"	28	Guernsey, Channel Islands, Channel Islands	Southampton	New York City	\N	\N	3
306	1	1	Allison, Master. Hudson Trevor	male	0.92	1	2	113781	151.55	C22 C26	S	8	Allison, Master Hudson Trevor	0.92	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	11	\N	1
307	1	1	Fleming, Miss. Margaret	female	\N	0	0	17421	110.8833	\N	C	298	and maid, Miss Margaret Fleming	42	Haverford, Pennsylvania, US	Cherbourg	Haverford, Pennsylvania, US	4	\N	1
308	1	1	Penasco y Castellana, Mrs. Victor de Satode (Maria Josefa Perez de Soto y Vallejo)	female	17	1	0	PC 17758	108.9	C65	C	228	Peñasco y Castellana, Mrs. Maria Josefa (née Perez de Soto y Vallejo)	22	Madrid, Spain	Cherbourg	New York, New York, US	8	\N	1
309	0	2	Abelson, Mr. Samuel	male	30	1	0	P/PP 3381	24	\N	C	327	Abelson, Mr. Samuel	30	Russia	Cherbourg	New York, New York, US	\N	\N	2
310	1	1	Francatelli, Miss. Laura Mabel	female	30	0	0	PC 17485	56.9292	E36	C	106	and secretary, Miss Laura Mabel Francatelli	31	London, England, UK	Cherbourg	New York, New York, US	1	\N	1
311	1	1	Hays, Miss. Margaret Bechstein	female	24	0	0	11767	83.1583	C54	C	156	Hays, Miss Margaret Bechstein	24	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
312	1	1	Ryerson, Miss. Emily Borie	female	18	2	2	PC 17608	262.375	B57 B59 B63 B66	C	250	Ryerson, Miss Emily Borie	18	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
313	0	2	Lahtinen, Mrs. William (Anna Sylfven)	female	26	1	1	250651	26	\N	S	483	Lahtinen, Mrs. Anna Amelia (née Sylfvén)	26	Minneapolis, Minnesota, US	Southampton	Minneapolis, Minnesota, US	\N	\N	2
314	0	3	Hendekovic, Mr. Ignjac	male	28	0	0	349243	7.8958	\N	S	868	Hendeković, Mr. Ignjac	28	Vagovina, Croatia	Southampton	Harrisburg, Pennsylvania, US	\N	306MB	3
315	0	2	Hart, Mr. Benjamin	male	43	1	1	F.C.C. 13529	26.25	\N	S	438	Hart, Mr. Benjamin	47	Ilford, Essex, England	Southampton	Winnipeg, Manitoba, Canada	\N	\N	2
316	1	3	Nilsson, Miss. Helmina Josefina	female	26	0	0	347470	7.8542	\N	S	1070	Nilsson, Miss Helmina Josefina	26	Ramkvilla, Småland, Sweden	Southampton	Joliet, Illinois, US	13	\N	3
317	1	2	Kantor, Mrs. Sinai (Miriam Sternin)	female	24	1	0	244367	26	\N	S	473	Kantor, Mrs. Miriam (née Sternin)	24	Vitebsk, Russian Empire	Southampton	Bronx, New York, US	12	\N	2
318	0	2	Moraweck, Dr. Ernest	male	54	0	0	29011	14	\N	S	515	Moraweck, Dr. Ernest	54	Frankfort, Kentucky, US	Southampton	Frankfort, Kentucky, US	\N	\N	2
319	1	1	Wick, Miss. Mary Natalie	female	31	0	2	36928	164.8667	C7	S	315	Wick, Miss Mary Natalie	31	Youngstown, Ohio, US	Southampton	Youngstown, Ohio, US	8	\N	1
320	1	1	Spedden, Mrs. Frederic Oakley (Margaretta Corning Stone)	female	40	1	1	16966	134.5	E34	C	270	Spedden, Mrs. Margaretta Corning (née Stone)	39	Tuxedo Park, New York, US	Cherbourg	Tuxedo Park, New York, US	3	\N	1
321	0	3	Dennis, Mr. Samuel	male	22	0	0	A/5 21172	7.25	\N	S	777	Dennis, Mr. Samuel	22	Week St Mary, Cornwall, England	Southampton	Saskatoon, Saskatchewan, Canada	\N	\N	3
322	0	3	Danoff, Mr. Yoto	male	27	0	0	349219	7.8958	\N	S	759	Danoff, Mr. Yoto	27	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
323	1	2	Slayter, Miss. Hilda Mary	female	30	0	0	234818	12.35	\N	Q	568	Slayter, Miss Hilda Mary	30	Halifax, Nova Scotia, Canada	Queenstown	Vancouver, British Columbia, Canada	13	\N	2
324	1	2	Caldwell, Mrs. Albert Francis (Sylvia Mae Harbaugh)	female	22	1	1	248738	29	\N	S	365	Caldwell, Mrs. Sylvia Mae (née Harbaugh)	28	Bangkok, Siam	Southampton	Roseville, Illinois, US	13	\N	2
325	0	3	Sage, Mr. George John Jr	male	\N	8	2	CA. 2343	69.55	\N	S	1177	Sage, Mr. George John	19	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
326	1	1	Young, Miss. Marie Grice	female	36	0	0	PC 17760	135.6333	C32	C	326	Young, Miss Marie Grice	36	New York, New York, US	Cherbourg	New York, New York, US	8	\N	1
327	0	3	Nysveen, Mr. Johan Hansen	male	61	0	0	345364	6.2375	\N	S	1078	Nysveen, Mr. Johan Hansen	61	Øyer, Norway	Southampton	Grand Forks, North Dakota, US	\N	\N	3
328	1	2	Ball, Mrs. (Ada E Hall)	female	36	0	0	28551	13	D	S	336	Ball, Mrs. Ada E. (née Hall)	36	Bristol, Avon, England	Southampton	Jacksonville, Florida, US	10	\N	2
329	1	3	Goldsmith, Mrs. Frank John (Emily Alice Brown)	female	31	1	1	363291	20.525	\N	S	828	Goldsmith, Mrs. Emily Alice (née Brown)	31	Strood, Kent, England	Southampton	Detroit, Michigan, US	C	\N	3
330	1	1	Hippach, Miss. Jean Gertrude	female	16	0	1	111361	57.9792	B18	C	161	Hippach, Miss Jean Gertrude	17	Chicago, Illinois, US	Cherbourg	Chicago, Illinois, US	4	\N	1
331	1	3	McCoy, Miss. Agnes	female	\N	2	0	367226	23.25	\N	Q	1008	McCoy, Miss Catherine Agnes	29	Carrickatane, Tyrone, Ireland	Queenstown	Brooklyn, New York, US	16	\N	3
332	0	1	Partner, Mr. Austen	male	45.5	0	0	113043	28.5	C124	S	224	Partner, Mr. Austin	40	Tolworth, London, England, UK	Southampton	Toronto, Ontario, Canada	\N	166MB	1
333	0	1	Graham, Mr. George Edward	male	38	0	1	PC 17582	153.4625	C91	S	135	Graham, Mr. George Edward	38	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	\N	147MB	1
334	0	3	Vander Planke, Mr. Leo Edmondus	male	16	2	0	345764	18	\N	S	1282	Vanderplancke, Mr. Leo Edmondus	15	Zwevezele, Belgium	Southampton	Fremont, Ohio, US	\N	\N	3
335	1	1	Frauenthal, Mrs. Henry William (Clara Heinsheimer)	female	\N	1	0	PC 17611	133.65	\N	S	121	Frauenthal, Mrs. Clara (née Heinsheimer)	42	London, England, UK	Southampton	New York, New York, US	5	\N	1
336	0	3	Denkoff, Mr. Mitto	male	\N	0	0	349225	7.8958	\N	S	775	Denkoff, Mr. Mitto	30	Unknown, Bulgaria	Southampton	Coon Rapids, Iowa, US	\N	\N	3
337	0	1	Pears, Mr. Thomas Clinton	male	29	1	0	113776	66.6	C2	S	225	Pears, Mr. Thomas Clinton	29	Isleworth, London, England, UK	Southampton	New York, New York, US	\N	\N	1
338	1	1	Burns, Miss. Elizabeth Margaret	female	41	0	0	16966	134.5	E40	C	273	and nurse, Miss Elizabeth Margaret Burns	41	Tuxedo Park, New York, US	Cherbourg	Tuxedo Park, New York, US	3	\N	1
339	1	3	Dahl, Mr. Karl Edwart	male	45	0	0	7598	8.05	\N	S	751	Dahl, Mr. Charles Edwart	45	Adelaide, South Australia, Australia	Southampton	Fingal, North Dakota, US	15	\N	3
340	0	1	Blackwell, Mr. Stephen Weart	male	45	0	0	113784	35.5	T	S	33	Blackwell, Mr. Stephen Weart	45	Trenton, New Jersey, US	Southampton	Trenton, New Jersey, US	\N	\N	1
341	1	2	Navratil, Master. Edmond Roger	male	2	1	1	230080	26	F2	S	523	Navratil, Master Edmond Roger	2	Nice, France	Southampton	New York City	D	\N	2
342	1	1	Fortune, Miss. Alice Elizabeth	female	24	3	2	19950	263	C23 C25 C27	S	116	Fortune, Miss Alice Elizabeth	24	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	10	\N	1
343	0	2	Collander, Mr. Erik Gustaf	male	28	0	0	248740	13	\N	S	381	Collander, Mr. Erik Gustaf	27	Helsinki, Finland, Russian Empire[note 6]	Southampton	Ashtabula, Ohio, US	\N	\N	2
344	0	2	Sedgwick, Mr. Charles Frederick Waddington	male	25	0	0	244361	13	\N	S	561	Sedgwick, Mr. Charles Frederick Waddington	25	Liverpool, Merseyside, England	Southampton	Minatitlán, Veracruz, Mexico	\N	\N	2
345	0	2	Fox, Mr. Stanley Hubert	male	36	0	0	229236	13	\N	S	413	Fox, Mr. Stanley Hubert	38	Rochester, New York, US	Southampton	Rochester, New York, US	\N	236MB	2
346	1	2	Brown, Miss. Amelia "Mildred"	female	24	0	0	248733	13	F33	S	4	and cook, Miss Amelia Mary "Mildred" Brown[59]	18	London, England, UK	Southampton	Montreal, Quebec, Canada	11	\N	1
347	1	2	Smith, Miss. Marion Elsie	female	40	0	0	31418	13	\N	S	570	Smith, Miss Marion Elsie	39	Basingstoke, Hampshire, England	Southampton	Washington, DC US	9	\N	2
348	1	3	Davison, Mrs. Thomas Henry (Mary E Finck)	female	\N	1	0	386525	16.1	\N	S	\N	\N	\N	\N	\N	\N	\N	\N	\N
349	1	3	Coutts, Master. William Loch "William"	male	3	1	1	C.A. 37671	15.9	\N	S	743	Coutts, Master William Loch "Willie"	9	London, England	Southampton	Brooklyn, New York, US	2	\N	3
350	0	3	Dimic, Mr. Jovan	male	42	0	0	315088	8.6625	\N	S	780	Dimić, Mr. Jovan	42	Ostrovica, Croatia	Southampton	Red Lodge, Montana, US	\N	\N	3
351	0	3	Odahl, Mr. Nils Martin	male	23	0	0	7267	9.225	\N	S	1090	Ödahl, Mr. Nils Martin	23	Örsjö, Kalmar, Sweden	Southampton	Peoria, Illinois, US	\N	\N	3
352	0	1	Williams-Lambert, Mr. Fletcher Fellows	male	\N	0	0	113510	35	C128	S	181	Lambert-Williams, Mr. Fletcher Fellows	43	London, England, UK	Southampton	Newark, New Jersey, US	\N	\N	1
353	0	3	Elias, Mr. Tannous	male	15	1	1	2695	7.2292	\N	C	799	Elias Nasrallah, Mr. Tannous	17	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
354	0	3	Arnold-Franchi, Mr. Josef	male	25	1	0	349237	17.8	\N	S	644	Arnold-Franchi, Mr. Josef	25	Altdorf, Uri, Switzerland	Southampton	New Glarus, Wisconsin, US	\N	\N	3
355	0	3	Yousif, Mr. Wazli	male	\N	0	0	2647	7.225	\N	C	1291	Wazni, Mr. Yousif Ahmed	25	Tebnin, Lebanon	Cherbourg	New York City	\N	\N	3
356	0	3	Vanden Steen, Mr. Leo Peter	male	28	0	0	345783	9.5	\N	S	1273	Van den Steen, Mr. Leo Peter	28	Haaltert, Belgium	Southampton	New York City	\N	\N	3
357	1	1	Bowerman, Miss. Elsie Edith	female	22	0	1	113505	55	E33	S	38	Bowerman, Miss Elsie Edith	22	St Leonards-on-Sea, East Sussex, England, UK	Southampton	New York, New York, US	6	\N	1
358	0	2	Funk, Miss. Annie Clemmer	female	38	0	0	237671	13	\N	S	415	Funk, Miss Annie Clemmer	38	Janjgir-Champa, British India, UK[note 3]	Southampton	Bally, Pennsylvania, US	\N	\N	2
359	1	3	McGovern, Miss. Mary	female	\N	0	0	330931	7.8792	\N	Q	1013	McGovern, Miss Mary	22	Corlough, Cavan, Ireland	Queenstown	New York City	13	\N	3
360	1	3	Mockler, Miss. Helen Mary "Ellie"	female	\N	0	0	330980	7.8792	\N	Q	1032	Mockler, Miss Ellen Mary	23	Currafarry, Galway, Ireland	Queenstown	New York City	16	\N	3
361	0	3	Skoog, Mr. Wilhelm	male	40	1	4	347088	27.9	\N	S	1214	Skoog, Mr. Wilhelm Johansson	40	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
362	0	2	del Carlo, Mr. Sebastiano	male	29	1	0	SC/PARIS 2167	27.7208	\N	C	396	del Carlo, Mr. Sebastiano	29	Montecarlo, Lucca, Tuscany, Italy	Cherbourg	Chicago, Illinois, US	\N	295MB	2
363	0	3	Barbara, Mrs. (Catherine David)	female	45	0	1	2691	14.4542	\N	C	673	Barbarah, Mrs. Katarin Dawud	45	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
364	0	3	Asim, Mr. Adola	male	35	0	0	SOTON/O.Q. 3101310	7.05	\N	S	647	Asim, Mr. Adola	35	Buenos Aires, Argentina	Southampton	New York City	\N	\N	3
365	0	3	O'Brien, Mr. Thomas	male	\N	1	0	370365	15.5	\N	Q	1079	O'Brien, Mr. Thomas	27	Pallasgreen, Limerick, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
366	0	3	Adahl, Mr. Mauritz Nils Martin	male	30	0	0	C 7076	7.25	\N	S	617	Adahl, Mr. Mauritz Nils Martin	30	Asarum, Småland, Sweden	Southampton	Brooklyn, New York, US	\N	72MB	3
367	1	1	Warren, Mrs. Frank Manley (Anna Sophia Atkinson)	female	60	1	0	110813	75.25	D37	C	306	Warren, Mrs. Anna Sophia (née Atkinson)	60	Portland, Oregon, US	Cherbourg	Portland, Oregon, US	5	\N	1
368	1	3	Moussa, Mrs. (Mantoura Boulos)	female	\N	0	0	2626	7.2292	\N	C	1042	Moussa, Mrs. Mantoura	35	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	?	\N	3
369	1	3	Jermyn, Miss. Annie	female	\N	0	0	14313	7.75	\N	Q	892	Jermyn, Miss Annie Jane	26	Ballydehob, Cork, Ireland	Queenstown	East Lynn, Massachusetts, US	D	\N	3
370	1	1	Aubart, Mme. Leontine Pauline	female	24	0	0	PC 17477	69.3	B35	C	19	Aubart, Mrs. Léontine Pauline[63]	24	Paris, France	Cherbourg	New York, New York, US	9	\N	1
371	1	1	Harder, Mr. George Achilles	male	25	1	0	11765	55.4417	E50	C	144	Harder, Mr. George Achilles	25	New York, New York, US	Cherbourg	New York, New York, US	5	\N	1
372	0	3	Wiklund, Mr. Jakob Alfred	male	18	1	0	3101267	6.4958	\N	S	1295	Wiklund, Mr. Jakob Alfred	18	Vaasa, Finland	Southampton	Montreal, Quebec, Canada	\N	314	3
373	0	3	Beavan, Mr. William Thomas	male	19	0	0	323951	8.05	\N	S	677	Beavan, Mr. William Thomas	18	Fillingham, Lincolnshire, England	Southampton	Russell, US	\N	\N	3
374	0	1	Ringhini, Mr. Sante	male	22	0	0	PC 17760	135.6333	\N	C	312	and manservant, Mr. Sante Righini	22	New York, New York, US	Cherbourg	New York, New York, US	\N	232MB	1
375	0	3	Palsson, Miss. Stina Viola	female	3	3	1	349909	21.075	\N	S	1107	Pålsson, Miss Stina Viola	3	Bjuv, Skåne, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
376	1	1	Meyer, Mrs. Edgar Joseph (Leila Saks)	female	\N	1	0	PC 17604	82.1708	\N	C	203	Meyer, Mrs. Leila (née Saks)	25	New York, New York, US	Cherbourg	New York, New York, US	6	\N	1
377	1	3	Landergren, Miss. Aurora Adelia	female	22	0	0	C 7077	7.25	\N	S	954	Landergren, Miss Aurora Adelia	22	Karlshamn, Blekinge, Sweden	Southampton	New York City	13	\N	3
378	0	1	Widener, Mr. Harry Elkins	male	27	0	2	113503	211.5	C82	C	320	Widener, Mr. Harry Elkins	27	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	\N	\N	1
379	0	3	Betros, Mr. Tannous	male	20	0	0	2648	4.0125	\N	C	680	Betros, Mr. Tannous	20	Zgharta, Lebanon	Cherbourg	Waterbury, Connecticut, US	\N	\N	3
380	0	3	Gustafsson, Mr. Karl Gideon	male	19	0	0	347069	7.775	\N	S	845	Gustafsson, Mr. Karl Gideon	19	Myren, Synnerby, Västergötland, Sweden	Southampton	Aberdeen, South Dakota, US	\N	\N	3
381	1	1	Bidois, Miss. Rosalie	female	42	0	0	PC 17757	227.525	\N	C	17	and maid, Miss Rosalie Bidois	46	New York, New York, US	Cherbourg	New York, New York, US	4	\N	1
382	1	3	Nakid, Miss. Maria ("Mary")	female	1	0	2	2653	15.7417	\N	C	1057	Nackid, Miss Maria	1	Zgharta, Lebanon	Cherbourg	Waterbury, Connecticut, US	C	\N	3
383	0	3	Tikkanen, Mr. Juho	male	32	0	0	STON/O 2. 3101293	7.925	\N	S	1256	Tikkanen, Mr. Juho	32	Pielavesi, Finland	Southampton	New York City	\N	\N	3
384	1	1	Holverson, Mrs. Alexander Oskar (Mary Aline Towner)	female	35	1	0	113789	52	\N	S	164	Holverson, Mrs. Mary Aline (née Towner)	35	New York, New York, US	Southampton	New York, New York, US	8	\N	1
385	0	3	Plotcharsky, Mr. Vasil	male	\N	0	0	349227	7.8958	\N	S	1136	Plotcharsky, Mr. Vasil	27	Unknown, Bulgaria	Southampton	Tulsa, Oklahoma, US	\N	\N	3
386	0	2	Davies, Mr. Charles Henry	male	18	0	0	S.O.C. 14879	73.5	\N	S	391	Davies, Mr. Charles Henry	21	Lyndhurst, Hampshire, England	Southampton	Eden, Manitoba, Canada	\N	\N	2
387	0	3	Goodwin, Master. Sidney Leonard	male	1	5	2	CA 2144	46.9	\N	S	838	Goodwin, Master Sidney Leslie	1	Fulham, England	Southampton	Niagara Falls, New York, US	\N	4MB[84]	3
388	1	2	Buss, Miss. Kate	female	36	0	0	27849	13	\N	S	360	Buss, Miss Kate	36	Sittingbourne, Kent, England	Southampton	San Francisco, US	9	\N	2
389	0	3	Sadlier, Mr. Matthew	male	\N	0	0	367655	7.7292	\N	Q	1172	Sadlier, Mr. Matthew	20	Mohill, Leitrim, Ireland	Queenstown	Lakewood Township, New Jersey, US	\N	\N	3
390	1	2	Lehmann, Miss. Bertha	female	17	0	0	SC 1748	12	\N	C	489	Lehmann, Miss Bertha	17	Lotzwil, Switzerland	Cherbourg	Central City, Iowa, US	12	\N	2
391	1	1	Carter, Mr. William Ernest	male	36	1	2	113760	120	B96 B98	S	57	Carter, Mr. William Ernest	36	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	C	\N	1
392	1	3	Jansson, Mr. Carl Olof	male	21	0	0	350034	7.7958	\N	S	887	Jansson, Mr. Carl Olof	21	Örebro, Sweden	Southampton	Swedeburg, Nebraska, US	A	\N	3
393	0	3	Gustafsson, Mr. Johan Birger	male	28	2	0	3101277	7.925	\N	S	844	Gustafsson, Mr. Johan Birger	28	Ruotsinpyhtää, Finland	Southampton	New York City	\N	\N	3
394	1	1	Newell, Miss. Marjorie	female	23	1	0	35273	113.275	D36	C	215	Newell, Miss Marjorie Anne	23	Lexington, Massachusetts, US	Cherbourg	Lexington, Massachusetts, US	6	\N	1
395	1	3	Sandstrom, Mrs. Hjalmar (Agnes Charlotta Bengtsson)	female	24	0	2	PP 9549	16.7	G6	S	1192	Sandström, Mrs. Agnes Charlotta (née Bengtsson)	24	Motala, Östergötland, Sweden	Southampton	San Francisco, US	13	\N	3
396	0	3	Johansson, Mr. Erik	male	22	0	0	350052	7.7958	\N	S	896	Johansson, Mr. Erik	22	Frostensmåla, Småland, Sweden	Southampton	St. Paul, Minnesota, US	\N	156MB	3
397	0	3	Olsson, Miss. Elina	female	31	0	0	350407	7.8542	\N	S	1096	Olsson, Miss Elina	31	Södra Brantevik, Sweden	Southampton	St. Paul, Minnesota, US	\N	\N	3
398	0	2	McKane, Mr. Peter David	male	46	0	0	28403	26	\N	S	507	McKane, Mr. Peter David	46	Guernsey, Channel Islands	Southampton	Rochester, New York, US	\N	\N	2
399	0	2	Pain, Dr. Alfred	male	23	0	0	244278	10.5	\N	S	531	Pain, Dr. Alfred "Alf"	23	Hamilton, Ontario, Canada	Southampton	Hamilton, Ontario, Canada	\N	\N	2
400	1	2	Trout, Mrs. William H (Jessie L)	female	28	0	0	240929	12.65	\N	S	578	Trout, Mrs. Jessie L.	26	Columbus, Ohio, US	Southampton	Columbus, Ohio, US	9	\N	2
401	1	3	Niskanen, Mr. Juha	male	39	0	0	STON/O 2. 3101289	7.925	\N	S	1074	Niskanen, Mr. Juha	39	Kivijärvi, Finland	Southampton	Boston, Massachusetts, US	9	\N	3
402	0	3	Adams, Mr. John	male	26	0	0	341826	8.05	\N	S	618	Adams, Mr. John	26	Bournemouth, Dorset, England	Southampton	La Porte City, Iowa, US	\N	103MB	3
403	0	3	Jussila, Miss. Mari Aina	female	21	1	0	4137	9.825	\N	S	916	Jussila, Miss Mari Aina	21	Paavola, Northern Ostrobothnia, Finland	Southampton	New York City	\N	\N	3
404	0	3	Hakkarainen, Mr. Pekka Pietari	male	28	1	0	STON/O2. 3101279	15.85	\N	S	849	Hakkarainen, Mr Pekka Pietari	28	Helsinki, Finland	Southampton	Monessen, Pennsylvania, US	\N	\N	3
405	0	3	Oreskovic, Miss. Marija	female	20	0	0	315096	8.6625	\N	S	1102	Orešković, Miss Marija	20	Konjsko Brdo, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
406	0	2	Gale, Mr. Shadrach	male	34	1	0	28664	21	\N	S	418	Gale, Mr. Shadrach	33	Harrowbarrow, Cornwall, England	Southampton	Clear Creek, Colorado, US	\N	\N	2
407	0	3	Widegren, Mr. Carl/Charles Peter	male	51	0	0	347064	7.75	\N	S	1294	Widegren, Mr. Carl Peter	51	Algutsrum, Kalmar, Sweden	Southampton	New York City	\N	\N	3
408	1	2	Richards, Master. William Rowe	male	3	1	1	29106	18.75	\N	S	554	Richards, Master William Rowe	3	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	4	\N	2
409	0	3	Birkeland, Mr. Hans Martin Monsen	male	21	0	0	312992	7.775	\N	S	681	Birkeland, Mr. Hans Martin Monsen	21	Bremnes, Norway	Southampton	New York City	\N	\N	3
410	0	3	Lefebre, Miss. Ida	female	\N	3	1	4133	25.4667	\N	S	966	Lefebvre, Miss Ida Franck-Marie-Joseph	3	Liévin, Pas-de-Calais, France	Southampton	Mystic, Iowa, US	\N	\N	3
411	0	3	Sdycoff, Mr. Todor	male	\N	0	0	349222	7.8958	\N	S	1200	Sdycoff, Mr. Theodor	42	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
412	0	3	Hart, Mr. Henry	male	\N	0	0	394140	6.8583	\N	Q	861	Hart, Mr. Henry John	27	Ballysadare, Sligo, Ireland	Queenstown	Boston, Massachusetts, US	\N	\N	3
413	1	1	Minahan, Miss. Daisy E	female	33	1	0	19928	90	C78	Q	207	Minahan, Miss Daisy E.	33	Fond du Lac, Wisconsin, US	Southampton	Fond du Lac, Wisconsin, US	14	\N	1
414	0	2	Cunningham, Mr. Alfred Fleming	male	\N	0	0	239853	0	\N	S	390	Cunningham, Mr. Alfred Fleming[60]	21	Belfast, Ireland	Belfast	New York City	\N	\N	2
415	1	3	Sundman, Mr. Johan Julian	male	44	0	0	STON/O 2. 3101269	7.925	\N	S	1241	Sundman, Mr. Johan Julian	44	Munsala, Finland	Southampton	Cheyenne, Wyoming, US	15	\N	3
416	0	3	Meek, Mrs. Thomas (Annie Louise Rowley)	female	\N	0	0	343095	8.05	\N	S	1022	Meek, Mrs. Anna "Annie" Louise Rowley	31	Penarth, Glamorgan, Wales	Southampton	New York City	\N	\N	3
417	1	2	Drew, Mrs. James Vivian (Lulu Thorne Christian)	female	34	1	1	28220	32.5	\N	S	404	Drew, Mrs. Lulu Thorne (née Christian)	34	Greenport, New York, US	Southampton	Greenport, New York, US	10	\N	2
418	1	2	Silven, Miss. Lyyli Karoliina	female	18	0	2	250652	13	\N	S	564	Silvén, Miss Lyyli Karolina	17	Tornio, Finland, Russian Empire[note 6]	Southampton	Minneapolis, Minnesota, US	16	\N	2
419	0	2	Matthews, Mr. William John	male	30	0	0	28228	13	\N	S	503	Matthews, Mr. William John	30	St Austell, Cornwall, England	Southampton	La Salle, Illinois, US	\N	\N	2
420	0	3	Van Impe, Miss. Catharina	female	10	0	2	345773	24.15	\N	S	1276	Van Impe, Miss Catharina	10	Kerksken, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
421	0	3	Gheorgheff, Mr. Stanio	male	\N	0	0	349254	7.8958	\N	C	823	Gheorgheff, Mr. Stanio	\N	Unknown, Bulgaria	Cherbourg	Butte, Montana, US	\N	\N	3
422	0	3	Charters, Mr. David	male	21	0	0	A/5. 13032	7.7333	\N	Q	721	Charters, Mr. David	28	Ballinalee, Longford, Ireland	Queenstown	New York City	\N	\N	3
423	0	3	Zimmerman, Mr. Leo	male	29	0	0	315082	7.875	\N	S	1314	Zimmermann, Mr. Leo	29	Todtmoos, Germany	Southampton	Saskatoon, Saskatchewan, Canada	\N	\N	3
424	0	3	Danbom, Mrs. Ernst Gilbert (Anna Sigrid Maria Brogren)	female	28	1	1	347080	14.4	\N	S	757	Danbom, Mrs. Anna Sigrid Maria (née Brogren)	28	Göteborg, Västergötland, Sweden	Southampton	Stanton, Iowa, US	\N	\N	3
425	0	3	Rosblom, Mr. Viktor Richard	male	18	1	1	370129	20.2125	\N	S	1162	Rosblom, Mr. Viktor Rickard	18	Suistamo, Finland	Southampton	Astoria, Oregon, US	\N	\N	3
426	0	3	Wiseman, Mr. Phillippe	male	\N	0	0	A/4. 34244	7.25	\N	S	1304	Wiseman, Mr. Phillippe	54	London, England	Southampton	Quebec City, Quebec, Canada	\N	\N	3
427	1	2	Clarke, Mrs. Charles V (Ada Maria Winfield)	female	28	1	0	2003	26	\N	S	378	Clarke, Mrs. Ada Maria	28	Netley Abbey, Hampshire, England	Southampton	San Francisco, California, US	14	\N	2
428	1	2	Phillips, Miss. Kate Florence ("Mrs Kate Louise Phillips Marshall")	female	19	0	0	250655	26	\N	S	540	Phillips, Miss Kate Florence (alias Mrs. Kate Marshall)[10][78]	19	Birmingham, Worcester, England	Southampton	Los Angeles, US	11	\N	2
429	0	3	Flynn, Mr. James	male	\N	0	0	364851	7.75	\N	Q	809	Flynn, Mr. James	28	Cuilkillew, Mayo, Ireland	Queenstown	New York City	\N	\N	3
430	1	3	Pickard, Mr. Berk (Berk Trembisky)	male	32	0	0	SOTON/O.Q. 392078	8.05	E10	S	1135	Pickard, Mr. Berk (Trembisky)	32	Warsaw, Poland	Southampton	San Francisco, US	9	\N	3
431	1	1	Bjornstrom-Steffansson, Mr. Mauritz Hakan	male	28	0	0	110564	26.55	C52	S	32	Björnström-Steffanson, Mr. Mauritz Håkan	28	Stockholm, Sweden	Southampton	Washington, DC, US	D	\N	1
432	1	3	Thorneycroft, Mrs. Percival (Florence Kate White)	female	\N	1	0	376564	16.1	\N	S	1255	Thorneycroft, Mrs. Florence Kate (née Stears)	32	Maidstone, Kent, England	Southampton	Clinton, New York, US	10	\N	3
433	1	2	Louch, Mrs. Charles Alexander (Alice Adelaide Slow)	female	42	1	0	SC/AH 3085	26	\N	S	496	Louch, Mrs. Alice Adelaide (née Slow)	42	Weston-super-Mare, North Somerset, England	Southampton	New York City	14	\N	2
434	0	3	Kallio, Mr. Nikolai Erland	male	17	0	0	STON/O 2. 3101274	7.125	\N	S	917	Kallio, Mr. Nikolai Erlantti	17	Kauhajoki, Finland	Southampton	Sudbury, Ontario, Canada	\N	\N	3
435	0	1	Silvey, Mr. William Baird	male	50	1	0	13507	55.9	E44	S	258	Silvey, Mr. William Baird	50	Duluth, Minnesota, US	Cherbourg	Duluth, Minnesota, US	\N	\N	1
436	1	1	Carter, Miss. Lucile Polk	female	14	1	2	113760	120	B96 B98	S	62	Carter, Miss Lucile Polk	13	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	4	\N	1
437	0	3	Ford, Miss. Doolina Margaret "Daisy"	female	21	2	2	W./C. 6608	34.375	\N	S	815	Ford, Miss Dollina Margaret	20	Rotherfield, East Sussex, England	Southampton	Essex County, New Jersey, US	\N	\N	3
438	1	2	Richards, Mrs. Sidney (Emily Hocking)	female	24	2	3	29106	18.75	\N	S	553	Richards, Mrs. Emily (née Hocking)	23	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	4	\N	2
439	0	1	Fortune, Mr. Mark	male	64	1	4	19950	263	C23 C25 C27	S	113	Fortune, Mr. Mark	64	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	\N	\N	1
440	0	2	Kvillner, Mr. Johan Henrik Johannesson	male	31	0	0	C.A. 18723	10.5	\N	S	481	Kvillner, Mr. Johan Henrik Johannesson	31	Trollhättan, Västergötland, Sweden	Southampton	Arlington, Virginia, US	\N	165MB	2
441	1	2	Hart, Mrs. Benjamin (Esther Ada Bloomfield)	female	45	1	1	F.C.C. 13529	26.25	\N	S	439	Hart, Mrs. Esther Ada (née Bloomfield)	48	Ilford, Essex, England	Southampton	Winnipeg, Manitoba, Canada	14	\N	2
442	0	3	Hampe, Mr. Leon	male	20	0	0	345769	9.5	\N	S	851	Hampe, Mr. Léon Jérome	19	Westrozebeke, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
443	0	3	Petterson, Mr. Johan Emil	male	25	1	0	347076	7.775	\N	S	1134	Pettersson, Mr. Johan Emil	25	Västermo, Södermanland, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
444	1	2	Reynaldo, Ms. Encarnacion	female	28	0	0	230434	13	\N	S	551	Reynaldo, Miss Encarnación	28	Marbella, Spain	Southampton	New York City	9	\N	2
445	1	3	Johannesen-Bratthammer, Mr. Bernt	male	\N	0	0	65306	8.1125	\N	S	894	Johannesen, Mr. Bernt Johannes	29	Avaldsnes, Stavanger, Norway	Southampton	New York City	13	\N	3
446	1	1	Dodge, Master. Washington	male	4	0	2	33638	81.8583	A34	S	99	Dodge, Master Washington, Jr.	4	San Francisco, California, US	Southampton	San Francisco, California, US	5	\N	1
447	1	2	Mellinger, Miss. Madeleine Violet	female	13	0	1	250644	19.5	\N	S	509	Mellinger, Miss Madeleine Violet	13	Wimbledon, London, England	Southampton	Bennington, Vermont, US	14	\N	2
448	1	1	Seward, Mr. Frederic Kimber	male	34	0	0	113794	26.55	\N	S	256	Seward, Mr. Frederic Kimber	34	New York, New York, US	Southampton	New York, New York, US	7	\N	1
449	1	3	Baclini, Miss. Marie Catherine	female	5	2	1	2666	19.2583	\N	C	670	Baqlini, Miss Mariya Katarin	5	Ḑuhūr ash Shuwayr, Lebanon	Cherbourg	Brooklyn, New York, US	C	\N	3
450	1	1	Peuchen, Major. Arthur Godfrey	male	52	0	0	113786	30.5	C104	S	230	Peuchen, Major Arthur Godfrey	52	Toronto, Ontario, Canada	Southampton	Toronto, Ontario, Canada	6	\N	1
451	0	2	West, Mr. Edwy Arthur	male	36	1	2	C.A. 34651	27.75	\N	S	596	West, Mr. Edwy Arthur	36	Bournemouth, Dorset, England	Southampton	Gainesville, Florida, US	\N	\N	2
452	0	3	Hagland, Mr. Ingvald Olai Olsen	male	\N	1	0	65303	19.9667	\N	S	847	Hagland, Mr. Ingvald Olai Olsen	28	Skaare, Haugesund, Norway	Southampton	Belmar, New Jersey, US	\N	\N	3
453	0	1	Foreman, Mr. Benjamin Laventall	male	30	0	0	113051	27.75	C111	C	112	Foreman, Mr. Benjamin Laventall	30	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
454	1	1	Goldenberg, Mr. Samuel L	male	49	1	0	17453	89.1042	C92	C	131	Goldenberg, Mr. Samuel L.	47	Paris, France	Cherbourg	New York, New York, US	5	\N	1
455	0	3	Peduzzi, Mr. Joseph	male	\N	0	0	A/5 2817	8.05	\N	S	1123	Peduzzi, Mr. Giuseppe	24	London, England	Southampton	New York City	\N	\N	3
456	1	3	Jalsevac, Mr. Ivan	male	29	0	0	349240	7.8958	\N	C	886	Jalševac, Mr. Ivan	29	Topolovac, Croatia	Cherbourg	Galesburg, Illinois, US	15	\N	3
457	0	1	Millet, Mr. Francis Davis	male	65	0	0	13509	26.55	E38	S	204	Millet, Mr. Francis Davis	65	East Bridgewater, Massachusetts, US	Cherbourg	East Bridgewater, Massachusetts, US	\N	249MB	1
458	1	1	Kenyon, Mrs. Frederick R (Marion)	female	\N	1	0	17464	51.8625	D21	S	177	Kenyon, Mrs. Marion (née Stauffer)[62][68]	31	Pittsburgh, Pennsylvania, US	Southampton	Pittsburgh, Pennsylvania, US	8	\N	1
459	1	2	Toomey, Miss. Ellen	female	50	0	0	F.C.C. 13531	10.5	\N	S	576	Toomey, Miss Ellen Mary	48	Indianapolis, Indiana, US	Southampton	Indianapolis, Indiana, US	9	\N	2
460	0	3	O'Connor, Mr. Maurice	male	\N	0	0	371060	7.75	\N	Q	1083	O'Connor, Mr. Maurice	16	Boherbue, Cork, Ireland	Queenstown	New York City	\N	\N	3
461	1	1	Anderson, Mr. Harry	male	48	0	0	19952	26.55	E12	S	10	Anderson, Mr. Harry	47	New York, New York, US	Southampton	New York, New York, US	3	\N	1
462	0	3	Morley, Mr. William	male	34	0	0	364506	8.05	\N	S	1039	Morley, Mr. William	34	Petworth, West Sussex, England	Southampton	New York City	\N	\N	3
463	0	1	Gee, Mr. Arthur H	male	47	0	0	111320	38.5	E63	S	128	Gee, Mr. Arthur H.	47	St Annes-on-Sea, Lancashire, England, UK	Southampton	Mexico City, Mexico	\N	275MB	1
464	0	2	Milling, Mr. Jacob Christian	male	48	0	0	234360	13	\N	S	512	Milling, Mr. Jacob Christian	48	Odense, Denmark	Southampton	Oregon, Wisconsin, US	\N	271MB	2
465	0	3	Maisner, Mr. Simon	male	\N	0	0	A/S 2816	8.05	\N	S	996	Maisner, Mr. Simon	34	London, England	Southampton	New York City	\N	\N	3
466	0	3	Goncalves, Mr. Manuel Estanslas	male	38	0	0	SOTON/O.Q. 3101306	7.05	\N	S	802	Estanislau, Mr. Manuel Gonçalves	37	Calheta, Madeira, Portugal	Southampton	New York City	\N	\N	3
467	0	2	Campbell, Mr. William	male	\N	0	0	239853	0	\N	S	368	Campbell, Mr. William Henry[60]	21	Belfast, Ireland	Belfast	New York City	\N	\N	2
468	0	1	Smart, Mr. John Montgomery	male	56	0	0	113792	26.55	\N	S	262	Smart, Mr. John Montgomery	56	Kildale, North Yorkshire, England, UK	Southampton	New York, New York, US	\N	\N	1
469	0	3	Scanlan, Mr. James	male	\N	0	0	36209	7.725	\N	Q	1198	Scanlan, Mr. James	22	Rathkeale, Limerick, Ireland	Queenstown	New York City	\N	\N	3
470	1	3	Baclini, Miss. Helene Barbara	female	0.75	2	1	2666	19.2583	\N	C	672	Baqlini, Miss Hileni Barbarah	0.75	Ḑuhūr ash Shuwayr, Lebanon	Cherbourg	Brooklyn, New York, US	C	\N	3
471	0	3	Keefe, Mr. Arthur	male	\N	0	0	323592	7.25	\N	S	927	Keefe, Mr. Arthur	39	Rahway, New Jersey, US	Southampton	Rahway, New Jersey, US	A	332O	3
472	0	3	Cacic, Mr. Luka	male	38	0	0	315089	8.6625	\N	S	705	Čačić, Mr. Luka	38	Široka Kula, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
473	1	2	West, Mrs. Edwy Arthur (Ada Mary Worth)	female	33	1	2	C.A. 34651	27.75	\N	S	597	West, Mrs. Ada Mary (née Worth)[62][79]	33	Bournemouth, Dorset, England	Southampton	Gainesville, Florida, US	10	\N	2
474	1	2	Jerwan, Mrs. Amin S (Marie Marthe Thuillard)	female	23	0	0	SC/AH Basle 541	13.7917	D	C	471	Jerwan, Mrs. Marie Marthe (née Thuillard)	23	New York City	Southampton	New York City	11	\N	2
475	0	3	Strandberg, Miss. Ida Sofia	female	22	0	0	7553	9.8375	\N	S	1235	Strandberg, Miss Ida Sofia	22	Turku, Finland	Southampton	New York City	\N	\N	3
476	0	1	Clifford, Mr. George Quincy	male	\N	0	0	110465	52	A14	S	79	Clifford, Mr. George Quincy	40	Stoughton, Massachusetts, US	Southampton	Stoughton, Massachusetts	\N	\N	1
477	0	2	Renouf, Mr. Peter Henry	male	34	1	0	31027	21	\N	S	549	Renouf, Mr. Peter Henry	33	Elizabeth, New Jersey, US	Southampton	Elizabeth, New Jersey, US	\N	\N	2
478	0	3	Braund, Mr. Lewis Richard	male	29	1	0	3460	7.0458	\N	S	690	Braund, Mr. Lewis Richard	29	Bridgerule, Devon, England	Southampton	Qu'Appelle Valley, Saskatchewan, Canada	\N	\N	3
479	0	3	Karlsson, Mr. Nils August	male	22	0	0	350060	7.5208	\N	S	922	Karlsson, Mr. Nils August	22	Örebro, Sweden	Southampton	Palmer, Massachusetts, US	\N	\N	3
480	1	3	Hirvonen, Miss. Hildur E	female	2	0	1	3101298	12.2875	\N	S	872	Hirvonen, Miss Hildur Elisabeth	2	Taalintehdas, Finland	Southampton	Monessen, Pennsylvania, US	15	\N	3
481	0	3	Goodwin, Master. Harold Victor	male	9	5	2	CA 2144	46.9	\N	S	837	Goodwin, Master Harold Victor	10	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
482	0	2	Frost, Mr. Anthony Wood "Archie"	male	\N	0	0	239854	0	\N	S	414	Frost, Mr. Anthony Wood "Archie"[60]	37	Belfast, Northern Ireland, UK	Belfast	New York City	\N	\N	2
483	0	3	Rouse, Mr. Richard Henry	male	50	0	0	A/5 3594	8.05	\N	S	1165	Rouse, Mr. Richard Henry	50	Sittingbourne, Kent, England	Southampton	Cleveland, Ohio, US	\N	\N	3
484	1	3	Turkula, Mrs. (Hedwig)	female	63	0	0	4134	9.5875	\N	S	1268	Turkula, Mrs. Hedvig	63	Jalasjärvi, Southern Ostrobothnia, Finland	Southampton	Hibbing, Minnesota, US	15	\N	3
485	1	1	Bishop, Mr. Dickinson H	male	25	1	0	11967	91.0792	B49	C	30	Bishop, Mr. Dickinson H. "Dick"	25	Dowagiac, Michigan, US	Cherbourg	Dowagiac, Michigan, US	7	\N	1
486	0	3	Lefebre, Miss. Jeannie	female	\N	3	1	4133	25.4667	\N	S	964	Lefebvre, Miss Jeannie Franck-Marie-Joseph	8	Liévin, Pas-de-Calais, France	Southampton	Mystic, Iowa, US	\N	\N	3
487	1	1	Hoyt, Mrs. Frederick Maxfield (Jane Anne Forby)	female	35	1	0	19943	90	C93	S	167	Hoyt, Mrs. Jane Anne (née Forby)	31	New York, New York, US	Southampton	Stamford, Connecticut, US	D	\N	1
488	0	1	Kent, Mr. Edward Austin	male	58	0	0	11771	29.7	B37	C	175	Kent, Mr. Edward Austin	58	Buffalo, New York, US	Cherbourg	Buffalo, New York, US	\N	258MB	1
489	0	3	Somerton, Mr. Francis William	male	30	0	0	A.5. 18509	8.05	\N	S	1226	Somerton, Mr. Francis William	30	Greatfield, Cheltenham, England	Southampton	Canastota, New York, US	\N	\N	3
490	1	3	Coutts, Master. Eden Leslie "Neville"	male	9	1	1	C.A. 37671	15.9	\N	S	744	Coutts, Master Neville Leslie	3	London, England	Southampton	Brooklyn, New York, US	2	\N	3
491	0	3	Hagland, Mr. Konrad Mathias Reiersen	male	\N	1	0	65304	19.9667	\N	S	848	Hagland, Mr. Konrad Mathias Reiersen	19	Skaare, Haugesund, Norway	Southampton	Belmar, New Jersey, US	\N	\N	3
492	0	3	Windelov, Mr. Einar	male	21	0	0	SOTON/OQ 3101317	7.25	\N	S	1302	Windeløv, Mr. Einar	21	Cape Town, South Africa	Southampton	New York City	\N	\N	3
493	0	1	Molson, Mr. Harry Markland	male	55	0	0	113787	30.5	C30	S	209	Molson, Mr. Harry Markland	55	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	\N	1
494	0	1	Artagaveytia, Mr. Ramon	male	71	0	0	PC 17609	49.5042	\N	C	14	Artagaveytia, Mr. Ramon	71	Buenos Aires, Argentina	Cherbourg	New York, New York, US	\N	22MB	1
495	0	3	Stanley, Mr. Edward Roland	male	21	0	0	A/4 45380	8.05	\N	S	1232	Stanley, Mr. Edward Rowland	21	Swanage, England	Southampton	Cleveland, Ohio, US	\N	\N	3
496	0	3	Yousseff, Mr. Gerious	male	\N	0	0	2627	14.4583	\N	C	1309	Youssef, Mr. Gerios (Abi Saab)	26	Hardîne, Lebanon	Cherbourg	Youngstown, Ohio, US	\N	312M	3
497	1	1	Eustis, Miss. Elizabeth Mussey	female	54	1	0	36947	78.2667	D20	C	108	Eustis, Miss Elizabeth Mussey	54	Brookline, Massachusetts, US	Cherbourg	Brookline, Massachusetts, US	4	\N	1
498	0	3	Shellard, Mr. Frederick William	male	\N	0	0	C.A. 6212	15.1	\N	S	1204	Shellard, Mr. Frederick William Blainey	55	Bristol, Avon, England	Southampton	Troy, New York, US	\N	\N	3
499	0	1	Allison, Mrs. Hudson J C (Bessie Waldo Daniels)	female	25	1	2	113781	151.55	C22 C26	S	5	Allison, Mrs. Bessie Waldo (née Daniels)	25	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	\N	1
500	0	3	Svensson, Mr. Olof	male	24	0	0	350035	7.7958	\N	S	1245	Svensson, Mr. Olof	24	Björkeberga, Skåne, Sweden	Southampton	New York City	\N	\N	3
501	0	3	Calic, Mr. Petar	male	17	0	0	315086	8.6625	\N	S	709	Čalić, Mr. Petar	17	Brezik, Croatia	Southampton	Sault Ste. Marie, Michigan, US	\N	\N	3
502	0	3	Canavan, Miss. Mary	female	21	0	0	364846	7.75	\N	Q	710	Canavan, Miss Mary	22	Tonacrick, Clare, Ireland	Queenstown	Philadelphia, Pennsylvania, US	\N	\N	3
503	0	3	O'Sullivan, Miss. Bridget Mary	female	\N	0	0	330909	7.6292	\N	Q	1089	O'Sullivan, Miss Bridget Mary	21	Glenduff, Kerry, Ireland	Queenstown	New York City	\N	\N	3
504	0	3	Laitinen, Miss. Kristina Sofia	female	37	0	0	4135	9.5875	\N	S	950	Laitinen, Miss Kristiina Sofia	37	Helsinki, Finland	Southampton	New York City	\N	\N	3
505	1	1	Maioni, Miss. Roberta	female	16	0	0	110152	86.5	B79	S	184	and maid, Miss Roberta Elizabeth Mary "Cissy" Maioni[69]	20	Vancouver, British Columbia, Canada	Southampton	Vancouver, British Columbia, Canada	8	\N	1
506	0	1	Penasco y Castellana, Mr. Victor de Satode	male	18	1	0	PC 17758	108.9	C65	C	227	Peñasco y Castellana, Mr. Victor	24	Madrid, Spain	Cherbourg	New York, New York, US	\N	\N	1
507	1	2	Quick, Mrs. Frederick Charles (Jane Richards)	female	33	0	2	26360	26	\N	S	545	Quick, Mrs. Jane (née Richards)	33	Plymouth, Devon, England	Southampton	Detroit, Michigan, US	11	\N	2
508	1	1	Bradley, Mr. George ("George Arthur Brayton")	male	\N	0	0	111427	26.55	\N	S	41	Brereton, Mr. George Andrew (alias George A. Brayton)	37	Los Angeles, California, US	Southampton	Los Angeles, California, US	9	\N	1
509	0	3	Olsen, Mr. Henry Margido	male	28	0	0	C 4001	22.525	\N	S	1092	Olsen, Mr. Henry Margido	28	Bergen, Norway	Southampton	New York City	\N	173MB	3
510	1	3	Lang, Mr. Fang	male	26	0	0	1601	56.4958	\N	S	956	Lang, Mr. Fang	26	Hong Kong, China	Southampton	New York City	14	\N	3
511	1	3	Daly, Mr. Eugene Patrick	male	29	0	0	382651	7.75	\N	Q	755	Daly, Mr. Eugene Patrick	29	Athlone, Westmeath, Ireland	Queenstown	New York City	B	\N	3
512	0	3	Webber, Mr. James	male	\N	0	0	SOTON/OQ 3101316	8.05	\N	S	1292	Webber, Mr. James	66	San Francisco, US	Southampton	San Francisco, US	\N	\N	3
513	1	1	McGough, Mr. James Robert	male	36	0	0	PC 17473	26.2875	E25	S	201	McGough, Mr. James Robert	35	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	7	\N	1
514	1	1	Rothschild, Mrs. Martin (Elizabeth L. Barrett)	female	54	1	0	PC 17603	59.4	\N	C	244	Rothschild, Mrs. Elizabeth Jane Anne (née Barrett)	54	New York, New York, US	Cherbourg	New York, New York, US	6	\N	1
515	0	3	Coleff, Mr. Satio	male	24	0	0	349209	7.4958	\N	S	729	Coleff, Mr. Fotio	24	Debnevo, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
516	0	1	Walker, Mr. William Anderson	male	47	0	0	36967	34.0208	D46	S	304	Walker, Mr. William Anderson	48	East Orange, New Jersey, US	Southampton	East Orange, New Jersey, US	\N	\N	1
517	1	2	Lemore, Mrs. (Amelia Milley)	female	34	0	0	C.A. 34260	10.5	F33	S	491	Lemore, Mrs. Amelia "Milley" (née Hunt)	34	Chicago, Illinois, US	Southampton	Chicago, Illinois, US	14	\N	2
518	0	3	Ryan, Mr. Patrick	male	\N	0	0	371110	24.15	\N	Q	1168	Ryan, Mr. Patrick	29	Askeaton, Limerick, Ireland	Queenstown	Bronx, New York, US	\N	\N	3
519	1	2	Angle, Mrs. William A (Florence "Mary" Agnes Hughes)	female	36	1	0	226875	26	\N	S	332	Angle, Mrs. Florence Agnes "Mary" (née Hughes)	36	Warwick, Warwickshire, England	Southampton	New York City	11	\N	2
520	0	3	Pavlovic, Mr. Stefo	male	32	0	0	349242	7.8958	\N	S	1117	Pavlović, Mr. Štefo	32	Vagovina, Croatia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
521	1	1	Perreault, Miss. Anne	female	30	0	0	12749	93.5	B73	S	155	and maid, Miss Mary Anne Perreault	33	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	3	\N	1
522	0	3	Vovk, Mr. Janko	male	22	0	0	349252	7.8958	\N	S	1287	Vovk, Mr. Janko	21	Jesenice, Slovenia	Southampton	St. Joseph, Minnesota, US	\N	\N	3
523	0	3	Lahoud, Mr. Sarkis	male	\N	0	0	2624	7.225	\N	C	949	Lahoud Ishaq Mowad, Mr. Sarkis	30	Zgharta, Lebanon	Cherbourg	Waterbury, Connecticut, US	\N	\N	3
524	1	1	Hippach, Mrs. Louis Albert (Ida Sophia Fischer)	female	44	0	1	111361	57.9792	B18	C	160	Hippach, Mrs. Ida Sophia (née Fischer)	44	Chicago, Illinois, US	Cherbourg	Chicago, Illinois, US	4	\N	1
525	0	3	Kassem, Mr. Fared	male	\N	0	0	2700	7.2292	\N	C	612	Abd al-Khaliq, Mr. Farid Qasim Husayn	18	Shana, Lebanon	Cherbourg	New York City	\N	\N	3
526	0	3	Farrell, Mr. James	male	40.5	0	0	367232	7.75	\N	Q	805	Farrell, Mr. James "Jim"	25	Killoe, Longford, Ireland	Queenstown	New York City	\N	68MB	3
527	1	2	Ridsdale, Miss. Lucy	female	50	0	0	W./C. 14258	10.5	\N	S	557	Ridsdale, Miss Lucy	50	London, England	Southampton	Marietta, Ohio, US	13	\N	2
528	0	1	Farthing, Mr. John	male	\N	0	0	PC 17483	221.7792	C95	S	286	and valet, Mr. John Farthing	57	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
529	0	3	Salonen, Mr. Johan Werner	male	39	0	0	3101296	7.925	\N	S	1187	Salonen, Mr. Johan Verner	39	Aberdeen, Washington, US	Southampton	Aberdeen, Washington, US	\N	\N	3
530	0	2	Hocking, Mr. Richard George	male	23	2	1	29104	11.5	\N	S	452	Hocking, Mr. Richard George	23	Akron, Ohio, US	Southampton	Akron, Ohio, US	\N	\N	2
531	1	2	Quick, Miss. Phyllis May	female	2	1	1	26360	26	\N	S	547	Quick, Miss Phyllis May	2	Plymouth, Devon, England	Southampton	Detroit, Michigan, US	11	\N	2
532	0	3	Toufik, Mr. Nakli	male	\N	0	0	2641	7.2292	\N	C	1059	Nakli-Khoury, Mr. Toufik	17	Hardîne, Lebanon	Cherbourg	New York City	\N	\N	3
533	0	3	Elias, Mr. Joseph Jr	male	17	1	1	2690	7.2292	\N	C	798	Elias, Mr. Joseph Jr.	15	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
534	1	3	Peter, Mrs. Catherine (Catherine Rizk)	female	\N	0	2	2668	22.3583	\N	C	701	Butrus-Youssef, Mrs. Katarin (née Rizk)	24	Sar'al, Syria	Cherbourg	Detroit, Michigan, US	C	\N	3
535	0	3	Cacic, Miss. Marija	female	30	0	0	315084	8.6625	\N	S	706	Čačić, Miss Marija	30	Široka Kula, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
536	1	2	Hart, Miss. Eva Miriam	female	7	0	2	F.C.C. 13529	26.25	\N	S	440	Hart, Miss Eva Miriam	7	Ilford, Essex, England	Southampton	Winnipeg, Manitoba, Canada	14	\N	2
537	0	1	Butt, Major. Archibald Willingham	male	45	0	0	113050	26.55	B38	S	47	Butt, Major Archibald Willingham	46	Washington, DC, US	Southampton	Washington, DC, US	\N	\N	1
538	1	1	LeRoy, Miss. Bertha	female	30	0	0	PC 17761	106.425	\N	C	102	and maid, Miss Berthe Leroy	27	Minneapolis, Minnesota, US	Cherbourg	Minneapolis, Minnesota, US	2	\N	1
539	0	3	Risien, Mr. Samuel Beard	male	\N	0	0	364498	14.5	\N	S	1155	Risien, Mr. Samuel Beard	69	Deal, Kent, England	Southampton	Groesbeck, Texas, US	\N	\N	3
540	1	1	Frolicher, Miss. Hedwig Margaritha	female	22	0	2	13568	49.5	B39	C	125	Frölicher-Stehli, Miss Hedwig Margaritha	22	Zürich, Switzerland	Cherbourg	New York, New York, US	5	\N	1
541	1	1	Crosby, Miss. Harriet R	female	36	0	2	WE/P 5735	71	B22	S	88	Crosby, Miss Harriette Rebecca	39	Milwaukee, Wisconsin, US	Southampton	Milwaukee, Wisconsin, US	7	\N	1
542	0	3	Andersson, Miss. Ingeborg Constanzia	female	9	4	2	347082	31.275	\N	S	635	Andersson, Miss Ingeborg Constanzia	9	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
543	0	3	Andersson, Miss. Sigrid Elisabeth	female	11	4	2	347082	31.275	\N	S	634	Andersson, Miss Sigrid Elisabeth	11	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
544	1	2	Beane, Mr. Edward	male	32	1	0	2908	26	\N	S	339	Beane, Mr. Edward	32	New York City	Southampton	New York City	13	\N	2
545	0	1	Douglas, Mr. Walter Donald	male	50	1	0	PC 17761	106.425	C86	C	100	Douglas, Mr. Walter Donald	50	Minneapolis, Minnesota, US	Cherbourg	Minneapolis, Minnesota, US	\N	62MB	1
546	0	1	Nicholson, Mr. Arthur Ernest	male	64	0	0	693	26	\N	S	217	Nicholson, Mr. Arthur Ernest	64	Shanklin, Isle of Wight, England, UK	Southampton	New York, New York, US	\N	263MB	1
547	1	2	Beane, Mrs. Edward (Ethel Clarke)	female	19	1	0	2908	26	\N	S	340	Beane, Mrs. Ethel (née Clarke)	19	Norwich, Norfolk, England	Southampton	New York City	13	\N	2
548	1	2	Padro y Manent, Mr. Julian	male	\N	0	0	SC/PARIS 2146	13.8625	\N	C	530	Padron Manent, Mr. Julian	26	Barcelona, Catalonia, Spain	Cherbourg	Havana, Cuba	9	\N	2
549	0	3	Goldsmith, Mr. Frank John	male	33	1	1	363291	20.525	\N	S	827	Goldsmith, Mr. Frank John	33	Strood, Kent, England	Southampton	Detroit, Michigan, US	\N	\N	3
550	1	2	Davies, Master. John Morgan Jr	male	8	1	1	C.A. 33112	36.75	\N	S	393	Davies, Master John Morgan Jr.	8	St. Ives, Cornwall, England, UK	Southampton	Houghton, Michigan, US	14	\N	2
551	1	1	Thayer, Mr. John Borland Jr	male	17	0	2	17421	110.8833	C70	C	299	Thayer, Mr. John Borland "Jack" III	17	Haverford, Pennsylvania, US	Cherbourg	Haverford, Pennsylvania, US	B	\N	1
552	0	2	Sharp, Mr. Percival James R	male	27	0	0	244358	26	\N	S	562	Sharp, Mr. Percival James	27	London, England, UK	Southampton	New York City	\N	\N	2
553	0	3	O'Brien, Mr. Timothy	male	\N	0	0	330979	7.8292	\N	Q	1081	O'Brien, Mr. Timothy	21	Drimoleague, Cork, Ireland	Queenstown	New York City	\N	\N	3
554	1	3	Leeni, Mr. Fahim ("Philip Zenni")	male	22	0	0	2620	7.225	\N	C	629	Al-Zainni, Mr. Fahim Ruhanna	22	Toula, Lebanon	Cherbourg	Dayton, Ohio, US	6	\N	3
555	1	3	Ohman, Miss. Velin	female	22	0	0	347085	7.775	\N	S	1091	Öhman, Miss Velin	22	Mariestad, Västergötland, Sweden	Southampton	Chicago, Illinois, US	C	\N	3
556	0	1	Wright, Mr. George	male	62	0	0	113807	26.55	\N	S	325	Wright, Mr. George	62	Halifax, Nova Scotia, Canada	Southampton	Halifax, Nova Scotia, Canada	\N	\N	1
557	1	1	Duff Gordon, Lady. (Lucille Christiana Sutherland) ("Mrs Morgan")	female	48	1	0	11755	39.6	A16	C	105	Duff Gordon, Lucy Christiana, Lady (née Sutherland)	48	London, England, UK	Cherbourg	New York, New York, US	1	\N	1
558	0	1	Robbins, Mr. Victor	male	\N	0	0	PC 17757	227.525	\N	C	\N	\N	\N	\N	\N	\N	\N	\N	\N
559	1	1	Taussig, Mrs. Emil (Tillie Mandelbaum)	female	39	1	1	110413	79.65	E67	S	292	Taussig, Mrs. Tillie (née Mandelbaum)	39	New York, New York, US	Southampton	New York, New York, US	8	\N	1
560	1	3	de Messemaeker, Mrs. Guillaume Joseph (Emma)	female	36	1	0	345572	17.4	\N	S	767	De Messemaeker, Mrs. Anna (née de Becker)	36	Tampico, Montana, US	Southampton	Tampico, Montana, US	13	\N	3
561	0	3	Morrow, Mr. Thomas Rowan	male	\N	0	0	372622	7.75	\N	Q	1040	Morrow, Mr. Thomas Rowan	30	Rathfriland, Down, Ireland	Queenstown	Gleichen, Alberta, Canada	\N	\N	3
562	0	3	Sivic, Mr. Husein	male	40	0	0	349251	7.8958	\N	S	1211	Sivić, Mr. Husein	40	Bosanska Krupa, Bosnia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
563	0	2	Norman, Mr. Robert Douglas	male	28	0	0	218629	13.5	\N	S	526	Norman, Mr. Robert Douglas	28	Glasgow, Scotland	Southampton	Houghton, Michigan, US	\N	287MB	2
564	0	3	Simmons, Mr. John	male	\N	0	0	SOTON/OQ 392082	8.05	\N	S	1208	Simmons, Mr. John	39	Leigh, Kent, England	Southampton	New York City	\N	\N	3
565	0	3	Meanwell, Miss. (Marion Ogden)	female	\N	0	0	SOTON/O.Q. 392087	8.05	\N	S	1020	Meanwell, Mrs. Mary Ann	63	Eastbourne, East Sussex, England	Southampton	New York City	\N	\N	3
566	0	3	Davies, Mr. Alfred J	male	24	2	0	A/4 48871	24.15	\N	S	762	Davies, Mr. Alfred John	24	West Bromwich, Staffordshire, England	Southampton	Pontiac, Michigan, US	\N	\N	3
567	0	3	Stoytcheff, Mr. Ilia	male	19	0	0	349205	7.8958	\N	S	1234	Stoytcheff, Mr. Ilia	19	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
568	0	3	Palsson, Mrs. Nils (Alma Cornelia Berglund)	female	29	0	4	349909	21.075	\N	S	1104	Pålsson, Mrs. Alma Cornelia (née Berglund)	29	Bjuv, Skåne, Sweden	Southampton	Chicago, Illinois, US	\N	206MB	3
569	0	3	Doharr, Mr. Tannous	male	\N	0	0	2686	7.2292	\N	C	750	Dahir, Mr. Tannous	28	Beirut, Lebanon	Cherbourg	Youngstown, Ohio, US	\N	\N	3
570	1	3	Jonsson, Mr. Carl	male	32	0	0	350417	7.8542	\N	S	912	Jonsson, Mr. Carl	32	Kalfsnäs, Småland, Sweden	Southampton	Huntley, Illinois, US	15	\N	3
571	1	2	Harris, Mr. George	male	62	0	0	S.W./PP 752	10.5	\N	S	436	Harris, Mr. George	62	London, England	Southampton	New York City	15	\N	2
572	1	1	Appleton, Mrs. Edward Dale (Charlotte Lamson)	female	53	2	0	11769	51.4792	C101	S	13	Appleton, Mrs. Charlotte Lane (née Lamson)	53	New York, New York, US	Southampton	New York, New York, US	2	\N	1
573	1	1	Flynn, Mr. John Irwin ("Irving")	male	36	0	0	PC 17474	26.3875	E25	S	111	Flynn, Mr. John Irwin	36	Brooklyn, New York, US	Southampton	Brooklyn, New York, US	5	\N	1
574	1	3	Kelly, Miss. Mary	female	\N	0	0	14312	7.75	\N	Q	931	Kelly, Miss Mary	22	Castlepollard, Westmeath, Ireland	Queenstown	New York City	D	\N	3
575	0	3	Rush, Mr. Alfred George John	male	16	0	0	A/4. 20589	8.05	\N	S	1166	Rush, Mr. Alfred George John	16	Strood, Kent, England	Southampton	Detroit, Michigan, US	\N	\N	3
576	0	3	Patchett, Mr. George	male	19	0	0	358585	14.5	\N	S	1116	Patchett, Mr. George	19	Wollaston, Northamptonshire, England	Southampton	Kitchener, Ontario, Canada	\N	\N	3
577	1	2	Garside, Miss. Ethel	female	34	0	0	243880	13	\N	S	419	Garside, Miss Ethel	34	Liverpool, Merseyside, England	Southampton	Brooklyn, New York, US	12	\N	2
578	1	1	Silvey, Mrs. William Baird (Alice Munger)	female	39	1	0	13507	55.9	E44	S	259	Silvey, Mrs. Alice (née Munger)	39	Duluth, Minnesota, US	Cherbourg	Duluth, Minnesota, US	11	\N	1
579	0	3	Caram, Mrs. Joseph (Maria Elias)	female	\N	1	0	2689	14.4583	\N	C	714	Caram, Mrs. Maria (née Elias)	18	Kfar Mechi, Syria	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
580	1	3	Jussila, Mr. Eiriik	male	32	0	0	STON/O 2. 3101286	7.925	\N	S	914	Jussila, Mr. Eiriik	32	Elimäki, Finland	Southampton	Monessen, Pennsylvania, US	15	\N	3
581	1	2	Christy, Miss. Julie Rachel	female	25	1	1	237789	30	\N	S	376	Christy, Miss Rachel Julie Cohen	25	London, England, UK	Southampton	Montreal, Quebec, Canada	12	\N	2
582	1	1	Thayer, Mrs. John Borland (Marian Longstreth Morris)	female	39	1	1	17421	110.8833	C68	C	297	Thayer, Mrs. Marian Longsteth (née Morris)	39	Haverford, Pennsylvania, US	Cherbourg	Haverford, Pennsylvania, US	4	\N	1
583	0	2	Downton, Mr. William James	male	54	0	0	28403	26	\N	S	402	Douton, Mr. William Joseph	55	Rochester, New York, US	Southampton	Rochester, New York, US	\N	\N	2
584	0	1	Ross, Mr. John Hugo	male	36	0	0	13049	40.125	A10	C	242	Ross, Mr. John Hugo	36	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	\N	\N	1
585	0	3	Paulner, Mr. Uscher	male	\N	0	0	3411	8.7125	\N	C	1139	Pullner, Mr. Uscher	16	Unknown, Unknown	Cherbourg	New York City	\N	\N	3
586	1	1	Taussig, Miss. Ruth	female	18	0	2	110413	79.65	E68	S	293	Taussig, Miss Ruth	18	New York, New York, US	Southampton	New York, New York, US	8	\N	1
587	0	2	Jarvis, Mr. John Denzil	male	47	0	0	237565	15	\N	S	467	Jarvis, Mr. Denzil John	47	Stoneygate, Leicestershire, England	Southampton	New York City	\N	\N	2
588	1	1	Frolicher-Stehli, Mr. Maxmillian	male	60	1	1	13567	79.2	B41	C	123	Frölicher, Mr. Maximilian Josef	60	Zürich, Switzerland	Cherbourg	New York, New York, US	5	\N	1
589	0	3	Gilinski, Mr. Eliezer	male	22	0	0	14973	8.05	\N	S	824	Gilinski, Mr. Eliezer	22	Abercynon, Glamorgan, Wales	Southampton	Chicago, Illinois, US	\N	47MB	3
590	0	3	Murdlin, Mr. Joseph	male	\N	0	0	A./5. 3235	8.05	\N	S	1049	Murdlin, Mr. Joseph	22	London, England	Southampton	New York City	\N	\N	3
591	0	3	Rintamaki, Mr. Matti	male	35	0	0	STON/O 2. 3101273	7.125	\N	S	1153	Rintamäki, Mr. Matti	35	Kyyny, Finland	Southampton	Sudbury, Ontario, Canada	\N	\N	3
592	1	1	Stephenson, Mrs. Walter Bertram (Martha Eustis)	female	52	1	0	36947	78.2667	D20	C	281	Stephenson, Mrs. Martha (née Eustis)	52	Paris, France	Cherbourg	Haverford, Pennsylvania, US	4	\N	1
593	0	3	Elsbury, Mr. William James	male	47	0	0	A/5 3902	7.25	\N	S	800	Elsbury, Mr. William James	47	Taunton, Somerset, England	Southampton	Gurnee, Illinois, US	\N	\N	3
594	0	3	Bourke, Miss. Mary	female	\N	0	2	364848	7.75	\N	Q	686	Bourke, Miss Mary	40	Carrowskehine, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
595	0	2	Chapman, Mr. John Henry	male	37	1	0	SC/AH 29037	26	\N	S	373	Chapman, Mr. John Henry	36	Liskeard, Cornwall, England	Southampton	Spokane, Washington, US	\N	17MB	2
596	0	3	Van Impe, Mr. Jean Baptiste	male	36	1	1	345773	24.15	\N	S	1274	Van Impe, Mr. Jean-Baptiste	36	Kerksken, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
597	1	2	Leitch, Miss. Jessie Wills	female	\N	0	0	248727	33	\N	S	490	Leitch, Miss Jessie Wills	31	London, England	Southampton	Chicago, Illinois, US	11	\N	2
598	0	3	Johnson, Mr. Alfred	male	49	0	0	LINE	0	\N	S	901	Johnson, Mr. Alfred	49	Millwood, England	Southampton	New York City	\N	\N	3
599	0	3	Boulos, Mr. Hanna	male	\N	0	0	2664	7.225	\N	C	853	Hanna, Mr. Bulus	18	Kfar Mechi, Syria	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
600	1	1	Duff Gordon, Sir. Cosmo Edmund ("Mr Morgan")	male	49	1	0	PC 17485	56.9292	A20	C	104	Duff Gordon, Sir Cosmo Edmund	49	London, England, UK	Cherbourg	New York, New York, US	1	\N	1
601	1	2	Jacobsohn, Mrs. Sidney Samuel (Amy Frances Christy)	female	24	2	1	243847	27	\N	S	466	Jacobsohn, Mrs. Amy Frances Christy (née Cohen)	24	London, England	Southampton	Montreal, Quebec, Canada	12	\N	2
602	0	3	Slabenoff, Mr. Petco	male	\N	0	0	349214	7.8958	\N	S	1220	Slabenoff, Mr. Peko	42	Unknown, Bulgaria	Southampton	New York City	\N	\N	3
603	0	1	Harrington, Mr. Charles H	male	\N	0	0	113796	42.4	\N	S	211	and valet, Mr. Charles Henry Harrington	37	Washington, DC, US	Southampton	Washington, DC, US	\N	\N	1
604	0	3	Torber, Mr. Ernst William	male	44	0	0	364511	8.05	\N	S	1260	Törber, Mr. Ernst Wilhelm	44	Unknown, Germany	Southampton	New York City	\N	\N	3
605	1	1	Homer, Mr. Harry ("Mr E Haven")	male	35	0	0	111426	26.55	\N	C	165	Homer, Mr. Harry (alias E. Haven)	40	Indianapolis, Indiana, US	Southampton	Indianapolis, Indiana, US	15	\N	1
606	0	3	Lindell, Mr. Edvard Bengtsson	male	36	1	0	349910	15.55	\N	S	975	Lindell, Mr. Edvard Bengtsson	36	Helsingborg, Skåne, Sweden	Southampton	Hartford, Connecticut, US	A	\N	3
607	0	3	Karaic, Mr. Milan	male	30	0	0	349246	7.8958	\N	S	919	Karajić, Mr. Milan	30	Vagovina, Croatia	Southampton	Youngstown, Ohio, US	\N	\N	3
608	1	1	Daniel, Mr. Robert Williams	male	27	0	0	113804	30.5	\N	S	92	Daniel, Mr. Robert Williams	27	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	3	\N	1
609	1	2	Laroche, Mrs. Joseph (Juliette Marie Louise Lafargue)	female	22	1	2	SC/Paris 2123	41.5792	\N	C	486	Laroche, Mrs. Juliette Marie Louise (née Lafargue)[62][75]	22	Paris, France	Cherbourg	Cap-Haïtien, Haiti	14	\N	2
610	1	1	Shutes, Miss. Elizabeth W	female	40	0	0	PC 17582	153.4625	C125	S	138	and governess, Miss Elizabeth Weed Shutes	40	Greenwich, Connecticut, US	Southampton	Greenwich, Connecticut, US	3	\N	1
611	0	3	Andersson, Mrs. Anders Johan (Alfrida Konstantia Brogren)	female	39	1	5	347082	31.275	\N	S	633	Andersson, Mrs. Alfrida Konstantia (née Brogren)	39	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
612	0	3	Jardin, Mr. Jose Neto	male	\N	0	0	SOTON/O.Q. 3101305	7.05	\N	S	888	Jardim, Mr. José Neto	21	Calheta, Madeira, Portugal	Southampton	New York City	\N	\N	3
613	1	3	Murphy, Miss. Margaret Jane	female	\N	1	0	367230	15.5	\N	Q	1051	Murphy, Miss Margaret Jane "Maggie/Mary"	25	Fostragh, Longford, Ireland	Queenstown	Philadelphia, Pennsylvania, US	16	\N	3
614	0	3	Horgan, Mr. John	male	\N	0	0	370377	7.75	\N	Q	876	Horgan, Mr. John	22	Unknown, Ireland	Queenstown	New York City	\N	\N	3
615	0	3	Brocklebank, Mr. William Alfred	male	35	0	0	364512	8.05	\N	S	693	Brocklebank, Mr. William Alfred	35	Broomfield, Essex, England	Southampton	New York City	\N	\N	3
616	1	2	Herman, Miss. Alice	female	24	1	2	220845	65	\N	S	444	Herman, Miss Alice	24	Yeovil, Somerset, England	Southampton	Bernardsville, New Jersey, US	9	\N	2
617	0	3	Danbom, Mr. Ernst Gilbert	male	34	1	1	347080	14.4	\N	S	756	Danbom, Mr. Ernst Gilbert	34	Göteborg, Västergötland, Sweden	Southampton	Stanton, Iowa, US	\N	197MB	3
618	0	3	Lobb, Mrs. William Arthur (Cordelia K Stanlick)	female	26	1	0	A/5. 3336	16.1	\N	S	983	Lobb, Mrs. Cordelia K. (née Stanlick)	26	Scranton, Pennsylvania, US	Southampton	Scranton, Pennsylvania, US	\N	55MB	3
619	1	2	Becker, Miss. Marion Louise	female	4	2	1	230136	39	F4	S	344	Becker, Miss Marion Louise	4	Guntur, Madras Province, British India	Southampton	Benton Harbor, Michigan, US	11	\N	2
620	0	2	Gavey, Mr. Lawrence	male	26	0	0	31028	10.5	\N	S	421	Gavey, Mr. Laurence	26	Guernsey, Channel Islands	Southampton	Elizabeth, New Jersey, US	\N	\N	2
621	0	3	Yasbeck, Mr. Antoni	male	27	1	0	2659	14.4542	\N	C	1306	Yasbak, Mr. Antun	27	Unknown, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	\N	\N	3
622	1	1	Kimball, Mr. Edwin Nelson Jr	male	42	1	0	11753	52.5542	D19	S	178	Kimball, Mr. Edwin Nelson Jr.	42	Boston, Massachusetts, US	Southampton	Boston, Massachusetts, US	5	\N	1
623	1	3	Nakid, Mr. Sahid	male	20	1	1	2653	15.7417	\N	C	1055	Nackid, Mr. Sahid	20	Zgharta, Lebanon	Cherbourg	Waterbury, Connecticut, US	C	\N	3
624	0	3	Hansen, Mr. Henry Damsgaard	male	21	0	0	350029	7.8542	\N	S	858	Hansen, Mr. Henry Damsgaard	21	Copenhagen, Denmark	Southampton	Racine, Wisconsin, US	\N	69MB	3
625	0	3	Bowen, Mr. David John "Dai"	male	21	0	0	54636	16.1	\N	S	687	Bowen, Mr. David John "Dai"	20	Treherbert, Glamorgan, Wales	Southampton	New York City	\N	\N	3
626	0	1	Sutton, Mr. Frederick	male	61	0	0	36963	32.3208	D50	S	289	Sutton, Mr. Frederick	61	Haddonfield, New Jersey, US	Southampton	Haddonfield, New Jersey, US	\N	46MB	1
627	0	2	Kirkland, Rev. Charles Leonard	male	57	0	0	219533	12.35	\N	Q	478	Kirkland, Reverend Charles Leonard	52	Glasgow, Scotland	Queenstown	Tuxford, Saskatchewan, Canada	\N	\N	2
628	1	1	Longley, Miss. Gretchen Fiske	female	21	0	0	13502	77.9583	D9	S	191	Longley, Miss Gretchen Fiske	21	Hudson, New York, US	Cherbourg	Hudson, New York, US	10	\N	1
629	0	3	Bostandyeff, Mr. Guentcho	male	26	0	0	349224	7.8958	\N	S	683	Bostandyeff, Mr. Guentcho	26	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
630	0	3	O'Connell, Mr. Patrick D	male	\N	0	0	334912	7.7333	\N	Q	1082	O'Connell, Mr. Patrick Denis	17	Kingwilliamstown, Cork, Ireland	Queenstown	New York City	\N	\N	3
631	1	1	Barkworth, Mr. Algernon Henry Wilson	male	80	0	0	27042	30	A23	S	21	Barkworth, Mr. Algernon Henry Wilson	47	Hessle, East Yorkshire, England, UK	Southampton	New York, New York, US	B	\N	1
632	0	3	Lundahl, Mr. Johan Svensson	male	51	0	0	347743	7.0542	\N	S	987	Lundahl, Mr. Johan Svensson	51	Fyrnan, Småland, Sweden	Southampton	Spokane, Washington, US	\N	\N	3
633	1	1	Stahelin-Maeglin, Dr. Max	male	32	0	0	13214	30.5	B50	C	277	Stähelin-Maeglin, Dr. Max	32	Basel, Switzerland	Southampton	New York, New York, US	3	\N	1
634	0	1	Parr, Mr. William Henry Marsh	male	\N	0	0	112052	0	\N	S	223	Parr, Mr. William Henry Marsh[60]	29	Belfast, Ireland, UK	Belfast	New York, New York, US	\N	\N	1
635	0	3	Skoog, Miss. Mabel	female	9	3	2	347088	27.9	\N	S	1217	Skoog, Miss Mabel	9	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
636	1	2	Davis, Miss. Mary	female	28	0	0	237668	13	\N	S	394	Davis, Miss Mary	28	London, England, UK	Southampton	Tottenville, New York, US	13	\N	2
637	0	3	Leinonen, Mr. Antti Gustaf	male	32	0	0	STON/O 2. 3101292	7.925	\N	S	967	Leinonen, Mr. Antti Gustaf	32	Valitaipale, Finland	Southampton	New York City	\N	\N	3
638	0	2	Collyer, Mr. Harvey	male	31	1	1	C.A. 31921	26.25	\N	S	383	Collyer, Mr. Harvey	31	Bishopstoke, Hampshire, England	Southampton	Payette, Idaho, US	\N	\N	2
639	0	3	Panula, Mrs. Juha (Maria Emilia Ojala)	female	41	0	5	3101295	39.6875	\N	S	1109	Panula, Mrs. Maija Emelia Abrahamintytar (née Ketola-Ojala)	41	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
640	0	3	Thorneycroft, Mr. Percival	male	\N	1	0	376564	16.1	\N	S	1254	Thorneycroft, Mr. Percival Thomas	36	Maidstone, Kent, England	Southampton	Clinton, New York, US	\N	\N	3
641	0	3	Jensen, Mr. Hans Peder	male	20	0	0	350050	7.8542	\N	S	889	Jensen, Mr. Hans Peder	20	Eskilstrup, Denmark	Southampton	Portland, Oregon, US	\N	\N	3
642	1	1	Sagesser, Mlle. Emma	female	24	0	0	PC 17477	69.3	B35	C	20	and maid, Miss Emma Sägesser	24	Paris, France	Cherbourg	New York, New York, US	9	\N	1
643	0	3	Skoog, Miss. Margit Elizabeth	female	2	3	2	347088	27.9	\N	S	1219	Skoog, Miss Margit Elizabeth	2	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
644	1	3	Foo, Mr. Choong	male	\N	0	0	1601	56.4958	\N	S	722	Cheong, Mr. Foo	32	Hong Kong, China	Southampton	New York City	C	\N	3
645	1	3	Baclini, Miss. Eugenie	female	0.75	2	1	2666	19.2583	\N	C	671	Baqlini, Miss Eujini	4	Ḑuhūr ash Shuwayr, Lebanon	Cherbourg	Brooklyn, New York, US	C	\N	3
646	1	1	Harper, Mr. Henry Sleeper	male	48	1	0	PC 17572	76.7292	D33	C	146	Harper, Mr. Henry Sleeper	48	New York, New York, US	Cherbourg	New York, New York, US	3	\N	1
647	0	3	Cor, Mr. Liudevit	male	19	0	0	349231	7.8958	\N	S	739	Čor, Mr. Liudevit	19	Kricina, Croatia	Southampton	Great Falls, Montana, US	\N	\N	3
712	0	1	Klaber, Mr. Herman	male	\N	0	0	113028	26.55	C124	S	180	Klaber, Mr. Herman	45	Portland, Oregon, US	Southampton	Portland, Oregon, US	\N	\N	1
648	1	1	Simonius-Blumer, Col. Oberst Alfons	male	56	0	0	13213	35.5	A26	C	260	Simonius-Blumer, Colonel Alfons	56	Basel, Switzerland	Southampton	New York, New York, US	3	\N	1
649	0	3	Willey, Mr. Edward	male	\N	0	0	S.O./P.P. 751	7.55	\N	S	1299	Willey, Mr. Edward	18	Market Drayton, Shropshire, England	Southampton	Schenectady, New York, US	\N	\N	3
650	1	3	Stanley, Miss. Amy Zillah Elsie	female	23	0	0	CA. 2314	7.55	\N	S	1231	Stanley, Miss Amy Zillah Elsie	24	Wallingford, Oxfordshire, England	Southampton	New Haven, Connecticut, US	C	\N	3
651	0	3	Mitkoff, Mr. Mito	male	\N	0	0	349221	7.8958	\N	S	1031	Mitkoff, Mr. Mito	23	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
652	1	2	Doling, Miss. Elsie	female	18	0	1	231919	23	\N	S	401	Doling, Miss Elsie	19	Southampton, Hampshire, England, UK	Southampton	New York City	?	\N	2
653	0	3	Kalvik, Mr. Johannes Halvorsen	male	21	0	0	8475	8.4333	\N	S	918	Kalvik, Mr. Johannes Halvorsen	21	Etnesjøen, Hordaland Fylke, Norway	Southampton	Story City, Iowa, US	\N	\N	3
654	1	3	O'Leary, Miss. Hanora "Norah"	female	\N	0	0	330919	7.8292	\N	Q	1088	O'Leary, Miss Hanora "Nora"	16	Kingwilliamstown, Cork, Ireland	Queenstown	New York City	13	\N	3
655	0	3	Hegarty, Miss. Hanora "Nora"	female	18	0	0	365226	6.75	\N	Q	864	Hegarty, Miss Hanora "Nora"	18	Whitechurch, Cork, Ireland	Queenstown	Charlestown, US	\N	\N	3
656	0	2	Hickman, Mr. Leonard Mark	male	24	2	0	S.O.C. 14879	73.5	\N	S	448	Hickman, Mr. Leonard Mark	24	Fritham, Hampshire, England	Southampton	Eden, Manitoba, Canada	\N	\N	2
657	0	3	Radeff, Mr. Alexander	male	\N	0	0	349223	7.8958	\N	S	1140	Radeff, Mr. Alexander	27	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
658	0	3	Bourke, Mrs. John (Catherine)	female	32	1	1	364849	15.5	\N	Q	685	Bourke, Mrs. Catherine (née McHugh)	32	Carrowskehine, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
659	0	2	Eitemiller, Mr. George Floyd	male	23	0	0	29751	13	\N	S	408	Eitemiller, Mr. George Floyd	23	London, England, UK	Southampton	Detroit, Michigan, US	\N	\N	2
660	0	1	Newell, Mr. Arthur Webster	male	58	0	2	35273	113.275	D48	C	213	Newell, Mr. Arthur Webster	58	Lexington, Massachusetts, US	Cherbourg	Lexington, Massachusetts, US	\N	122MB	1
661	1	1	Frauenthal, Dr. Henry William	male	50	2	0	PC 17611	133.65	\N	S	120	Frauenthal, Dr. Henry William	49	London, England, UK	Southampton	New York, New York, US	5	\N	1
662	0	3	Badt, Mr. Mohamed	male	40	0	0	2623	7.225	\N	C	666	Badt, Mr. Mohamed	40	Tripoli, Lebanon	Cherbourg	New York City	\N	\N	3
663	0	1	Colley, Mr. Edward Pomeroy	male	47	0	0	5727	25.5875	E58	S	80	Colley, Mr. Edward Pomeroy	37	Dublin, Ireland, UK[note 1]	Southampton	Vancouver, British Columbia, Canada	\N	\N	1
664	0	3	Coleff, Mr. Peju	male	36	0	0	349210	7.4958	\N	S	730	Coltcheff, Mr. Peju	36	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
665	1	3	Lindqvist, Mr. Eino William	male	20	1	0	STON/O 2. 3101285	7.925	\N	S	977	Lindqvist, Mr. Eino William	20	Taalintehdas, Finland	Southampton	Monessen, Pennsylvania, US	15	\N	3
666	0	2	Hickman, Mr. Lewis	male	32	2	0	S.O.C. 14879	73.5	\N	S	447	Hickman, Mr. Lewis	30	Fritham, Hampshire, England	Southampton	The Pas, Manitoba, Canada	\N	256MB	2
667	0	2	Butler, Mr. Reginald Fenton	male	25	0	0	234686	13	\N	S	361	Butler, Mr. Reginald Fenton	25	Southsea, Hampshire, England	Southampton	New York City	\N	97MB	2
668	0	3	Rommetvedt, Mr. Knud Paust	male	\N	0	0	312993	7.775	\N	S	1160	Rommetvedt, Mr. Knud Paust	49	Hogstad, Norway	Southampton	New York City	\N	\N	3
669	0	3	Cook, Mr. Jacob	male	43	0	0	A/5 3536	8.05	\N	S	736	Cook, Mr. Jacob (Kukk, Mr. Jakob?)	43	Unknown (Estonia?), Russia (Estonia?)	Southampton	New York City	\N	\N	3
670	1	1	Taylor, Mrs. Elmer Zebley (Juliet Cummins Wright)	female	\N	1	0	19996	52	C126	S	295	Taylor, Mrs. Juliet Cummins (née Wright)	48	London, England, UK	Southampton	East Orange, New Jersey, US	5	\N	1
671	1	2	Brown, Mrs. Thomas William Solomon (Elizabeth Catherine Ford)	female	40	1	1	29750	39	\N	S	356	Brown, Mrs. Elizabeth Catherine (née Ford)	40	Cape Town, South Africa, UK	Southampton	Seattle, Washington, US	14	\N	2
672	0	1	Davidson, Mr. Thornton	male	31	1	0	F.C. 12750	52	B71	S	93	Davidson, Mr. Thornton	31	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	\N	1
673	0	2	Mitchell, Mr. Henry Michael	male	70	0	0	C.A. 24580	10.5	\N	S	513	Mitchell, Mr. Henry Michael	71	Guernsey, Channel Islands	Southampton	Toledo, Ohio, US	\N	\N	2
674	1	2	Wilhelms, Mr. Charles	male	31	0	0	244270	13	\N	S	602	Whilems, Mr. Charles	32	London, England	Southampton	New York City	9	\N	2
675	0	2	Watson, Mr. Ennis Hastings	male	\N	0	0	239856	0	\N	S	587	Watson, Mr. Ennis Hastings[60]	15	Belfast, Northern Ireland, UK	Belfast	New York City	\N	\N	2
676	0	3	Edvardsson, Mr. Gustaf Hjalmar	male	18	0	0	349912	7.775	\N	S	794	Edvardsson, Mr. Gustaf Hjalmar	18	Tofta, Uppland, Sweden	Southampton	Joliet, Illinois, US	\N	\N	3
677	0	3	Sawyer, Mr. Frederick Charles	male	24.5	0	0	342826	8.05	\N	S	1197	Sawyer, Mr. Frederick Charles	33	Basingstoke, Hampshire, England	Southampton	Halley, Michigan, US	\N	284MB	3
678	1	3	Turja, Miss. Anna Sofia	female	18	0	0	4138	9.8417	\N	S	1267	Turja, Miss Anna Sofiia	18	Oulainen, Oulu, Finland	Southampton	Ashtabula, Ohio, US	15	\N	3
679	0	3	Goodwin, Mrs. Frederick (Augusta Tyler)	female	43	1	6	CA 2144	46.9	\N	S	832	Goodwin, Mrs. Augusta (née Tyler)	43	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
1008	\N	3	Thomas, Mr. John	male	\N	0	0	2681	6.4375	\N	C	1251	Thomas, Mr. John	34	Unknown, Unknown	Cherbourg	Columbus, Ohio, US	\N	\N	3
680	1	1	Cardeza, Mr. Thomas Drake Martinez	male	36	0	1	PC 17755	512.3292	B51 B53 B55	C	52	Cardeza, Mr. Thomas Drake Martinez	36	Germantown, Pennsylvania, US	Cherbourg	Germantown, Pennsylvania, US	3	\N	1
681	0	3	Peters, Miss. Katie	female	\N	0	0	330935	8.1375	\N	Q	1128	Peters, Miss Catherine "Katie"	26	Cahir, Tipperary, Ireland	Queenstown	New York City	\N	\N	3
682	1	1	Hassab, Mr. Hammad	male	27	0	0	PC 17572	76.7292	D49	C	147	and dragoman, Mr. Hammad Hassab	27	Cairo, Egypt	Cherbourg	New York, New York, US	3	\N	1
683	0	3	Olsvigen, Mr. Thor Anderson	male	20	0	0	6563	9.225	\N	S	1099	Olsvingen, Mr. Thor Andersen	20	Vikersund, Norway	Southampton	Carneron, US	\N	89MB	3
684	0	3	Goodwin, Mr. Charles Edward	male	14	5	2	CA 2144	46.9	\N	S	834	Goodwin, Mr. Charles Edward	14	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
685	0	2	Brown, Mr. Thomas William Solomon	male	60	1	1	29750	39	\N	S	355	Brown, Mr. Thomas William Solomon	60	Cape Town, South Africa, UK[note 4]	Southampton	Seattle, Washington, US	\N	\N	2
686	0	2	Laroche, Mr. Joseph Philippe Lemercier	male	25	1	2	SC/Paris 2123	41.5792	\N	C	485	Laroche, Mr. Joseph Philippe Lemercier	25	Paris, France	Cherbourg	Cap-Haïtien, Haiti	\N	\N	2
687	0	3	Panula, Mr. Jaako Arnold	male	14	4	1	3101295	39.6875	\N	S	1111	Panula, Mr. Jaakko Arnold	15	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
688	0	3	Dakic, Mr. Branko	male	19	0	0	349228	10.1708	\N	S	753	Dakić, Mr. Branko	19	Gornji Miholjac, Croatia	Southampton	New York City	\N	\N	3
689	0	3	Fischer, Mr. Eberhard Thelander	male	18	0	0	350036	7.7958	\N	S	807	Fischer, Mr. Eberhard Thelander	18	Björkeberga, Skåne, Sweden	Southampton	New York City	\N	\N	3
690	1	1	Madill, Miss. Georgette Alexandra	female	15	0	1	24160	211.3375	B5	S	193	Madill, Miss Georgette Alexandra	16	St Louis, Missouri, US	Southampton	St Louis, Missouri, US	2	\N	1
691	1	1	Dick, Mr. Albert Adrian	male	31	1	0	17474	57	B20	S	95	Dick, Mr. Albert Adrian	31	Calgary, Alberta, Canada	Southampton	Calgary, Alberta, Canada	3	\N	1
692	1	3	Karun, Miss. Manca	female	4	0	1	349256	13.4167	\N	C	924	Karun, Miss Manca ("Anna")	4	Milje, Slovenia	Southampton	Galesburg, Illinois, US	15	\N	3
693	1	3	Lam, Mr. Ali	male	\N	0	0	1601	56.4958	\N	S	952	Lam, Mr. Ali	37	Hong Kong, China	Southampton	New York City	C	\N	3
694	0	3	Saad, Mr. Khalil	male	25	0	0	2672	7.225	\N	C	1171	Saad, Mr. Khalil	25	Kfar Mechi, Syria	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
695	0	1	Weir, Col. John	male	60	0	0	113800	26.55	\N	S	307	Weir, Colonel John	59	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
696	0	2	Chapman, Mr. Charles Henry	male	52	0	0	248731	13.5	\N	S	372	Chapman, Mr. Charles Henry	52	Bronx, New York, US	Southampton	Bronx, New York, US	\N	130MB	2
697	0	3	Kelly, Mr. James	male	44	0	0	363592	8.05	\N	S	929	Kelly, Mr. James	44	Leixlip, Kildare, Ireland	Queenstown	New Haven, Connecticut, US	\N	\N	3
698	1	3	Mullens, Miss. Katherine "Katie"	female	\N	0	0	35852	7.7333	\N	Q	1047	Mullen, Miss Katherine "Katie"	19	Esker, Longford, Ireland	Queenstown	New York City	16	\N	3
699	0	1	Thayer, Mr. John Borland	male	49	1	1	17421	110.8833	C68	C	296	Thayer, Mr. John Borland II	49	Haverford, Pennsylvania, US	Cherbourg	Haverford, Pennsylvania, US	\N	\N	1
700	0	3	Humblen, Mr. Adolf Mathias Nicolai Olsen	male	42	0	0	348121	7.65	F G63	S	878	Humblen, Mr. Adolf Mathias Nicolai Olsen	42	Borgund, Møre og Romsdal, Norway	Southampton	Milwaukee, Wisconsin, US	\N	\N	3
701	1	1	Astor, Mrs. John Jacob (Madeleine Talmadge Force)	female	18	1	0	PC 17757	227.525	C62 C64	C	16	Astor, Mrs. Madeleine Talmage (née Force)[61][62]	18	New York, New York, US	Cherbourg	New York, New York, US	4	\N	1
702	1	1	Silverthorne, Mr. Spencer Victor	male	35	0	0	PC 17475	26.2875	E24	S	257	Silverthorne, Mr. Spencer Victor	35	St Louis, Missouri, US	Southampton	St Louis, Missouri, US	5	\N	1
703	0	3	Barbara, Miss. Saiide	female	18	0	1	2691	14.4542	\N	C	674	Barbarah, Miss Saidah	12	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
704	0	3	Gallagher, Mr. Martin	male	25	0	0	36864	7.7417	\N	Q	820	Gallagher, Mr. Martin	29	Caltra, Galway, Ireland	Queenstown	New York City	\N	\N	3
705	0	3	Hansen, Mr. Henrik Juul	male	26	1	0	350025	7.8542	\N	S	857	Hansen, Mr. Henrik Juul	26	Holeby, Storstrøm, Denmark	Southampton	Racine, Wisconsin, US	\N	\N	3
706	0	2	Morley, Mr. Henry Samuel ("Mr Henry Marshall")	male	39	0	0	250655	26	\N	S	516	Morley, Mr. Henry Samuel (alias Mr. Henry Marshall)	38	Birmingham, Worcester, England	Southampton	Los Angeles, US	\N	\N	2
707	1	2	Kelly, Mrs. Florence "Fannie"	female	45	0	0	223596	13.5	\N	S	477	Kelly, Miss Florence "Fannie"	45	London, England	Southampton	New York City	9	\N	2
708	1	1	Calderhead, Mr. Edward Pennington	male	42	0	0	PC 17476	26.2875	E24	S	48	Calderhead, Mr. Edward Pennington	42	New York, New York, US	Southampton	New York, New York, US	5	\N	1
709	1	1	Cleaver, Miss. Alice	female	22	0	0	113781	151.55	\N	S	9	and nurse, Miss Alice Catherine Cleaver	22	London, England, UK	Southampton	Montreal, Quebec, Canada	11	\N	1
710	1	3	Moubarek, Master. Halim Gonios ("William George")	male	\N	1	1	2661	15.2458	\N	C	1046	Mubarik, Master Halim Gonios	4	Hardîne, Lebanon	Cherbourg	Houtzdale, Pennsylvania, US	C	\N	3
711	1	1	Mayne, Mlle. Berthe Antonine ("Mrs de Villiers")	female	24	0	0	PC 17482	49.5042	C90	C	198	Mayné, Miss Bertha Antonine	24	Brussels, Belgium	Cherbourg	Montreal, Quebec, Canada	6	\N	1
713	1	1	Taylor, Mr. Elmer Zebley	male	48	1	0	19996	52	C126	S	294	Taylor, Mr. Elmer Zebley	48	London, England, UK	Southampton	East Orange, New Jersey, US	5	\N	1
714	0	3	Larsson, Mr. August Viktor	male	29	0	0	7545	9.4833	\N	S	957	Larsson, Mr. August Viktor	29	Stamford, Connecticut, US	Southampton	Stamford, Connecticut, US	\N	\N	3
715	0	2	Greenberg, Mr. Samuel	male	52	0	0	250647	13	\N	S	429	Greenberg, Mr. Samuel	52	Bronx, New York, US	Southampton	Bronx, New York, US	\N	19MB	2
716	0	3	Soholt, Mr. Peter Andreas Lauritz Andersen	male	19	0	0	348124	7.65	F G73	S	1225	Søholt, Mr. Peter Andreas Lauritz Andersen	19	Ålesund, Møre og Romsdal, Norway	Southampton	Minneapolis, Minnesota, US	\N	\N	3
717	1	1	Endres, Miss. Caroline Louise	female	38	0	0	PC 17757	227.525	C45	C	18	and nurse, Miss Caroline Louise Endres	39	New York, New York, US	Cherbourg	New York, New York, US	4	\N	1
718	1	2	Troutt, Miss. Edwina Celia "Winnie"	female	27	0	0	34218	10.5	E101	S	579	Troutt, Miss Edwina Celia "Winnie"	27	Bath, Somerset, England	Southampton	Auburndale, Florida, US	16	\N	2
719	0	3	McEvoy, Mr. Michael	male	\N	0	0	36568	15.5	\N	Q	1012	McEvoy, Mr. Michael	19	Dublin, Ireland	Queenstown	New York City	\N	\N	3
720	0	3	Johnson, Mr. Malkolm Joackim	male	33	0	0	347062	7.775	\N	S	905	Johnson, Mr. Malkolm Joackim	33	Minneapolis, Minnesota, US	Southampton	Minneapolis, Minnesota, US	\N	37MB	3
721	1	2	Harper, Miss. Annie Jessie "Nina"	female	6	0	1	248727	33	\N	S	435	Harper, Miss Annie Jessie "Nina"	6	London, England	Southampton	Chicago, Illinois, US	11	\N	2
722	0	3	Jensen, Mr. Svend Lauritz	male	17	1	0	350048	7.0542	\N	S	891	Jensen, Mr. Svend Lauritz	17	Eskilstrup, Denmark	Southampton	Portland, Oregon, US	\N	\N	3
723	0	2	Gillespie, Mr. William Henry	male	34	0	0	12233	13	\N	S	427	Gillespie, Mr. William Henry	34	Abbeyleix, Laois, Ireland[note 1]	Southampton	Vancouver, British Columbia, Canada	\N	\N	2
724	0	2	Hodges, Mr. Henry Price	male	50	0	0	250643	13	\N	S	455	Hodges, Mr. Henry Price	50	Southampton, Hampshire, England	Southampton	Boston, Massachusetts, US	\N	149MB	2
725	1	1	Chambers, Mr. Norman Campbell	male	27	1	0	113806	53.1	E8	S	71	Chambers, Mr. Norman Campbell	27	New York, New York, US	Southampton	New York, New York, US	5	\N	1
726	0	3	Oreskovic, Mr. Luka	male	20	0	0	315094	8.6625	\N	S	1101	Orešković, Mr. Luka	20	Konjsko Brdo, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
727	1	2	Renouf, Mrs. Peter Henry (Lillian Jefferys)	female	30	3	0	31027	21	\N	S	550	Renouf, Mrs. Lillian "Lily" (née Jefferys)	30	Elizabeth, New Jersey, US	Southampton	Elizabeth, New Jersey, US	12	\N	2
728	1	3	Mannion, Miss. Margareth	female	\N	0	0	36866	7.7375	\N	Q	1000	Mannion, Miss Margaret	28	Caltra, Galway, Ireland	Queenstown	New York City	16	\N	3
729	0	2	Bryhl, Mr. Kurt Arnold Gottfrid	male	25	1	0	236853	26	\N	S	358	Bryhl, Mr. Kurt Arnold Gottfrid	25	Skara, Västergötland, Sweden	Southampton	Rockford, Illinois, US	\N	\N	2
730	0	3	Ilmakangas, Miss. Pieta Sofia	female	25	1	0	STON/O2. 3101271	7.925	\N	S	882	Ilmakangas, Miss Pieta Sofia	25	Paavola, Northern Ostrobothnia, Finland	Southampton	New York City	\N	\N	3
731	1	1	Allen, Miss. Elisabeth Walton	female	29	0	0	24160	211.3375	B5	S	1	Allen, Miss Elizabeth Walton	29	St Louis, Missouri, US	Southampton	St Louis, Missouri, US	2	\N	1
732	0	3	Hassan, Mr. Houssein G N	male	11	0	0	2699	18.7875	\N	C	879	Husayn, Master Husayn Mahumud	11	Fredericksburg, Virginia, US	Cherbourg	Fredericksburg, Virginia, US	\N	\N	3
733	0	2	Knight, Mr. Robert J	male	\N	0	0	239855	0	\N	S	479	Knight, Mr. Robert J.[60]	39	Belfast, Ireland	Belfast	New York City	\N	\N	2
734	0	2	Berriman, Mr. William John	male	23	0	0	28425	13	\N	S	348	Berriman, Mr. William John	23	St. Ives, Cornwall, England	Southampton	Calumet, Michigan, US	\N	\N	2
735	0	2	Troupiansky, Mr. Moses Aaron	male	23	0	0	233639	13	\N	S	577	Troupiansky, Mr. Moses Aaron	23	London, England	Southampton	New York City	\N	\N	2
736	0	3	Williams, Mr. Leslie	male	28.5	0	0	54636	16.1	\N	S	1301	Williams, Mr. Leslie	28	Tonypandy, Glamorgan, Wales	Southampton	New York City	\N	14MB	3
737	0	3	Ford, Mrs. Edward (Margaret Ann Watson)	female	48	1	3	W./C. 6608	34.375	\N	S	814	Ford, Mrs. Margaret Ann (née Watson)	48	Rotherfield, East Sussex, England	Southampton	Essex County, New Jersey, US	\N	\N	3
738	1	1	Lesurer, Mr. Gustave J	male	35	0	0	PC 17755	512.3292	B101	C	53	and valet, Mr. Gustave J. Lesueur	35	Germantown, Pennsylvania, US	Cherbourg	Germantown, Pennsylvania, US	3	\N	1
739	0	3	Ivanoff, Mr. Kanio	male	\N	0	0	349201	7.8958	\N	S	883	Ivanoff, Mr. Kanio	20	Malka Ribnya, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
740	0	3	Nankoff, Mr. Minko	male	\N	0	0	349218	7.8958	\N	S	1061	Nankoff, Mr. Minko	32	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
741	1	1	Hawksford, Mr. Walter James	male	\N	0	0	16988	30	D45	S	151	Hawksford, Mr. Walter James	45	Kingston, Surrey, England, UK	Southampton	New York, New York, US	3	\N	1
742	0	1	Cavendish, Mr. Tyrell William	male	36	1	0	19877	78.85	C46	S	66	Cavendish, Mr. Tyrell William	36	London, England, UK	Southampton	New York, New York, US	\N	172MB	1
743	1	1	Ryerson, Miss. Susan Parker "Suzette"	female	21	2	2	PC 17608	262.375	B57 B59 B63 B66	C	249	Ryerson, Miss Susan Parker "Suzette"	21	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
744	0	3	McNamee, Mr. Neal	male	24	1	0	376566	16.1	\N	S	1017	McNamee, Mr. Neal	27	Convoy, Donegal, Ireland, England	Southampton	Philadelphia, Pennsylvania, US	\N	\N	3
745	1	3	Stranden, Mr. Juho	male	31	0	0	STON/O 2. 3101288	7.925	\N	S	1236	Strandén, Mr. Juho Niilonpoika	31	Muljula, Kitee, Finland	Southampton	Duluth, Minnesota, US	9	\N	3
746	0	1	Crosby, Capt. Edward Gifford	male	70	1	1	WE/P 5735	71	B22	S	86	Crosby, Captain Edward	70	Milwaukee, Wisconsin, US	Southampton	Milwaukee, Wisconsin, US	\N	269MB	1
747	0	3	Abbott, Mr. Rossmore Edward	male	16	1	1	C.A. 2673	20.25	\N	S	610	Abbott, Mr. Rossmore Edward	16	East Providence, Rhode Island, US	Southampton	East Providence, Rhode Island, US	\N	\N	3
748	1	2	Sinkkonen, Miss. Anna	female	30	0	0	250648	13	\N	S	566	Sinkkonen, Miss Anna	30	Turku, Finland, Russian Empire[note 6]	Southampton	Brighton, Boston, Massachusetts, US	10	\N	2
749	0	1	Marvin, Mr. Daniel Warner	male	19	1	0	113773	53.1	D30	S	196	Marvin, Mr. Daniel Warner	18	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
750	0	3	Connaghton, Mr. Michael	male	31	0	0	335097	7.75	\N	Q	732	Connaghton, Mr. Michael	31	Brooklyn, New York, US	Queenstown	Brooklyn, New York, US	\N	\N	3
751	1	2	Wells, Miss. Joan	female	4	1	1	29103	23	\N	S	594	Wells, Miss Joan	4	Heamoor, Cornwall, England	Southampton	Akron, Ohio, US	14	\N	2
752	1	3	Moor, Master. Meier	male	6	0	1	392096	12.475	E121	S	1035	Moor, Master Meier	7	Unknown, Russia	Southampton	Chicago, Illinois, US	14	\N	3
753	0	3	Vande Velde, Mr. Johannes Joseph	male	33	0	0	345780	9.5	\N	S	1272	Van de Velde, Mr. Johannes Josef	35	Denderhoutem, Belgium	Southampton	New York City	\N	\N	3
754	0	3	Jonkoff, Mr. Lalio	male	23	0	0	349204	7.8958	\N	S	911	Jonkoff, Mr. Lalju	23	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
755	1	2	Herman, Mrs. Samuel (Jane Laver)	female	48	1	2	220845	65	\N	S	443	Herman, Mrs. Jane (née Laver)	48	Yeovil, Somerset, England	Southampton	Bernardsville, New Jersey, US	9	\N	2
756	1	2	Hamalainen, Master. Viljo	male	0.67	1	1	250649	14.5	\N	S	432	Hämäläinen, Master Viljo Unto Johannes (William Hamlin)	1	Detroit, Michigan, US	Southampton	Detroit, Michigan, US	4	\N	2
757	0	3	Carlsson, Mr. August Sigfrid	male	28	0	0	350042	7.7958	\N	S	716	Carlsson, Mr. August Sigfrid	24	Dagsås, Halland, Sweden	Southampton	Tower, Minnesota, US	\N	\N	3
758	0	2	Bailey, Mr. Percy Andrew	male	18	0	0	29108	11.5	\N	S	334	Bailey, Mr. Percy Andrew	18	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	\N	\N	2
759	0	3	Theobald, Mr. Thomas Leonard	male	34	0	0	363294	8.05	\N	S	1247	Theobald, Mr. Thomas Leonard	34	Strood, Kent, England	Southampton	Detroit, Michigan, US	\N	176MB	3
760	1	1	Rothes, the Countess. of (Lucy Noel Martha Dyer-Edwards)	female	33	0	0	110152	86.5	B77	S	183	Leslie, Lucy Noël Martha, Countess of Rothes (née Dyer-Edwardes)	34	Vancouver, British Columbia, Canada	Southampton	Vancouver, British Columbia, Canada	8	\N	1
761	0	3	Garfirth, Mr. John	male	\N	0	0	358585	14.5	\N	S	821	Garfirth, Mr. John	21	Wollaston, Northamptonshire, England	Southampton	Kitchener, Ontario, Canada	\N	\N	3
762	0	3	Nirva, Mr. Iisakki Antino Aijo	male	41	0	0	SOTON/O2 3101272	7.125	\N	S	1073	Nirva, Mr. Iisakki Antino Äijö	41	Kauhajoki, Finland	Southampton	Sudbury, Ontario, Canada	\N	\N	3
763	1	3	Barah, Mr. Hanna Assi	male	20	0	0	2663	7.2292	\N	C	852	Hanna, Mr. Borak Suleiman	27	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	15	\N	3
764	1	1	Carter, Mrs. William Ernest (Lucile Polk)	female	36	1	2	113760	120	B96 B98	S	60	Carter, Mrs. Lucile (née Polk)	36	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	4	\N	1
765	0	3	Eklund, Mr. Hans Linus	male	16	0	0	347074	7.775	\N	S	795	Eklund, Mr. Hans Linus	16	Kårberg, Örebro, Sweden	Southampton	Jerome Junction, Arizona, US	\N	\N	3
766	1	1	Hogeboom, Mrs. John C (Anna Andrews)	female	51	1	0	13502	77.9583	D11	S	162	Hogeboom, Mrs. Anna Louisa (née Andrews)	51	Hudson, New York, US	Cherbourg	Hudson, New York, US	10	\N	1
767	0	1	Brewe, Dr. Arthur Jackson	male	\N	0	0	112379	39.6	\N	C	42	Brewe, Dr. Arthur Jackson	45	Philadelphia, Pennsylvania, US	Cherbourg	Philadelphia, Pennsylvania, US	\N	\N	1
768	0	3	Mangan, Miss. Mary	female	30.5	0	0	364850	7.75	\N	Q	999	Mangan, Miss Mary	32	Carrowkehine, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	61MB	3
769	0	3	Moran, Mr. Daniel J	male	\N	1	0	371110	24.15	\N	Q	1038	Moran, Mr. Daniel James	27	Askeaton, Limerick, Ireland	Queenstown	Brooklyn, New York, US	\N	\N	3
770	0	3	Gronnestad, Mr. Daniel Danielsen	male	32	0	0	8471	8.3625	\N	S	840	Grønnestad, Mr. Daniel Danielsen	32	Bokn, Norway	Southampton	Portland, North Dakota, US	\N	\N	3
771	0	3	Lievens, Mr. Rene Aime	male	24	0	0	345781	9.5	\N	S	972	Lievens, Mr. René Gustave Aimé	24	Haaltert, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
772	0	3	Jensen, Mr. Niels Peder	male	48	0	0	350047	7.8542	\N	S	890	Jensen, Mr. Niels Peder "Rasmus"	48	Portland, Oregon, US	Southampton	Portland, Oregon, US	\N	\N	3
773	0	2	Mack, Mrs. (Mary)	female	57	0	0	S.O./P.P. 3	10.5	E77	S	497	Mack, Mrs. Mary (née Lacy)	57	Southampton, Hampshire, England	Southampton	New York City	\N	52MB	2
774	0	3	Elias, Mr. Dibo	male	\N	0	0	2674	7.225	\N	C	797	Elias, Mr. Dibo	29	Unknown, Lebanon	Cherbourg	New York City	\N	\N	3
775	1	2	Hocking, Mrs. Elizabeth (Eliza Needs)	female	54	1	3	29105	23	\N	S	451	Hocking, Mrs. Elizabeth "Eliza" (née Neads)	54	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	4	\N	2
776	0	3	Myhrman, Mr. Pehr Fabian Oliver Malkolm	male	18	0	0	347078	7.75	\N	S	1054	Myhrman, Mr. Pehr Fabian Oliver Malkolm	18	Kristinehamn, Värmland, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
777	0	3	Tobin, Mr. Roger	male	\N	0	0	383121	7.75	F38	Q	1257	Tobin, Mr. Roger	20	Cahir, Tipperary, Ireland	Queenstown	New York City	\N	\N	3
778	1	3	Emanuel, Miss. Virginia Ethel	female	5	0	0	364516	12.475	\N	S	801	Emanuel, Miss Virginia Ethel	6	New York City, New York, US	Southampton	New York City	13	\N	3
779	0	3	Kilgannon, Mr. Thomas J	male	\N	0	0	36865	7.7375	\N	Q	937	Kilgannon, Mr. Thomas	22	Currafarry, Galway, Ireland	Queenstown	New York City	\N	\N	3
780	1	1	Robert, Mrs. Edward Scott (Elisabeth Walton McMillan)	female	43	0	1	24160	211.3375	B3	S	235	Robert, Mrs. Elisabeth Walton (née McMillan)	43	St Louis, Missouri, US	Southampton	St Louis, Missouri, US	2	\N	1
781	1	3	Ayoub, Miss. Banoura	female	13	0	0	2687	7.2292	\N	C	661	Ayyub Dahir, Miss Bannurah	15	Beirut, Lebanon	Cherbourg	Owen Sound, Ontario, Canada	C	\N	3
782	1	1	Dick, Mrs. Albert Adrian (Vera Gillespie)	female	17	1	0	17474	57	B20	S	96	Dick, Mrs. Vera (née Gillespie)	17	Calgary, Alberta, Canada	Southampton	Calgary, Alberta, Canada	3	\N	1
783	0	1	Long, Mr. Milton Clyde	male	29	0	0	113501	30	D6	S	190	Long, Mr. Milton Clyde	29	Springfield, Massachusetts, US	Southampton	Springfield, Massachusetts, US	\N	126MB	1
784	0	3	Johnston, Mr. Andrew G	male	\N	1	2	W./C. 6607	23.45	\N	S	907	Johnston, Mr. Andrew Emslie	35	Thornton Heath, London, England	Southampton	New London, Connecticut, US	\N	\N	3
785	0	3	Ali, Mr. William	male	25	0	0	SOTON/O.Q. 3101312	7.05	\N	S	626	Ali, Mr. William	25	Buenos Aires, Argentina	Southampton	New York City	\N	79MB	3
786	0	3	Harmer, Mr. Abraham (David Lishin)	male	25	0	0	374887	7.25	\N	S	981	Livshin, Mr. David ("Abraham Harmer")	25	Manchester, England	Southampton	Montreal, Quebec, Canada	\N	\N	3
787	1	3	Sjoblom, Miss. Anna Sofia	female	18	0	0	3101265	7.4958	\N	S	1213	Sjöblom, Miss Anna Sofiia	18	Munsala, Finland	Southampton	Olympia, Washington, US	16	\N	3
788	0	3	Rice, Master. George Hugh	male	8	4	1	382652	29.125	\N	Q	1148	Rice, Master George Hugh	8	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	\N	3
789	1	3	Dean, Master. Bertram Vere	male	1	1	2	C.A. 2315	20.575	\N	S	772	Dean, Master Bertram Vere	1	Bartley Farm, Hampshire, England	Southampton	Wichita, Kansas, US	10	\N	3
790	0	1	Guggenheim, Mr. Benjamin	male	46	0	0	PC 17593	79.2	B82 B84	C	141	Guggenheim, Mr. Benjamin	46	Paris, France	Cherbourg	New York, New York, US	\N	\N	1
791	0	3	Keane, Mr. Andrew "Andy"	male	\N	0	0	12460	7.75	\N	Q	926	Keane, Mr. Andrew "Andy"	23	Athenry, Galway, Ireland	Queenstown	Auburndale, Florida, US	\N	\N	3
792	0	2	Gaskell, Mr. Alfred	male	16	0	0	239865	26	\N	S	420	Gaskell, Mr. William Alfred	18	Liverpool, Merseyside, England	Southampton	Montreal, Quebec, Canada	\N	\N	2
793	0	3	Sage, Miss. Stella Anna	female	\N	8	2	CA. 2343	69.55	\N	S	1176	Sage, Miss Stella Anne	20	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
794	0	1	Hoyt, Mr. William Fisher	male	\N	0	0	PC 17600	30.6958	\N	C	168	Hoyt, Mr. William Fisher	42	New York, New York, US	Cherbourg	New York, New York, US	14	[66][67]	1
795	0	3	Dantcheff, Mr. Ristiu	male	25	0	0	349203	7.8958	\N	S	760	Dantcheff, Mr. Ristju	25	Terziysko, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
796	0	2	Otter, Mr. Richard	male	39	0	0	28213	13	\N	S	528	Otter, Mr. Richard	39	Middleburg Heights, Ohio, US	Southampton	Middleburg Heights, Ohio, US	\N	\N	2
797	1	1	Leader, Dr. Alice (Farnham)	female	49	0	0	17465	25.9292	D17	S	182	Leader, Dr. Alice (née Farnham)	49	New York, New York, US	Southampton	New York, New York, US	8	\N	1
798	1	3	Osman, Mrs. Mara	female	31	0	0	349244	8.6833	\N	S	668	Banski, Mrs. Mara (née Osman)	31	Vagovina, Croatia	Southampton	Steelton, Pennsylvania, US	?	\N	3
799	0	3	Ibrahim Shawah, Mr. Yousseff	male	30	0	0	2685	7.2292	\N	C	1202	Shawah, Mr. Yousseff Ibrahim	33	Beirut, Lebanon	Cherbourg	New York City	\N	\N	3
800	0	3	Van Impe, Mrs. Jean Baptiste (Rosalie Paula Govaert)	female	30	1	1	345773	24.15	\N	S	1275	Van Impe, Mrs. Rosalie Paula (née Govaert)	30	Kerksken, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
801	0	2	Ponesell, Mr. Martin	male	34	0	0	250647	13	\N	S	542	Ponesell, Mr. Martin	34	Southampton, Hampshire, England	Southampton	New York City	\N	\N	2
802	1	2	Collyer, Mrs. Harvey (Charlotte Annie Tate)	female	31	1	1	C.A. 31921	26.25	\N	S	384	Collyer, Mrs. Charlotte Annie (née Tate)	31	Bishopstoke, Hampshire, England	Southampton	Payette, Idaho, US	14	\N	2
803	1	1	Carter, Master. William Thornton II	male	11	1	2	113760	120	B96 B98	S	63	Carter, Master William Thornton II	11	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	4	\N	1
804	1	3	Thomas, Master. Assad Alexander	male	0.42	0	1	2625	8.5167	\N	C	1250	Tannous, Master As'ad Iskandar Fa'ud	0.42	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	16	\N	3
805	1	3	Hedman, Mr. Oskar Arvid	male	27	0	0	347089	6.975	\N	S	863	Hedman, Mr. Oskar Arvid	27	St. Paul, Minnesota, US	Southampton	St. Paul, Minnesota, US	15	\N	3
806	0	3	Johansson, Mr. Karl Johan	male	31	0	0	347063	7.775	\N	S	898	Johansson, Mr. Karl Johan	31	Duluth, Minnesota, US	Southampton	Duluth, Minnesota, US	\N	\N	3
807	0	1	Andrews, Mr. Thomas Jr	male	39	0	0	112050	0	A36	S	12	Andrews, Mr. Thomas[60]	39	Belfast, Ireland, UK	Belfast	New York, New York, US	\N	\N	1
808	0	3	Pettersson, Miss. Ellen Natalia	female	18	0	0	347087	7.775	\N	S	1133	Pettersson, Miss Ellen Natalia	18	Stockholm, Uppland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
809	0	2	Meyer, Mr. August	male	39	0	0	248723	13	\N	S	511	Meyer, Mr. August	31	Harrow, London, England	Southampton	New York City	\N	\N	2
810	1	1	Chambers, Mrs. Norman Campbell (Bertha Griggs)	female	33	1	0	113806	53.1	E8	S	72	Chambers, Mrs. Bertha (née Griggs)	32	New York, New York, US	Southampton	New York, New York, US	5	\N	1
811	0	3	Alexander, Mr. William	male	26	0	0	3474	7.8875	\N	S	623	Alexander, Mr. William	23	Great Yarmouth, Norfolk, England	Southampton	Albion, Michigan, US	\N	\N	3
812	0	3	Lester, Mr. James	male	39	0	0	A/4 48871	24.15	\N	S	971	Lester, Mr. James	39	West Bromwich, Staffordshire, England	Southampton	Pontiac, Michigan, US	\N	\N	3
813	0	2	Slemen, Mr. Richard James	male	35	0	0	28206	10.5	\N	S	569	Slemen, Mr. Richard James	35	Landrake, Cornwall, England	Southampton	Nashua, New Hampshire, US	\N	\N	2
814	0	3	Andersson, Miss. Ebba Iris Alfrida	female	6	4	2	347082	31.275	\N	S	636	Andersson, Miss Ebba Iris Alfrida	6	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
815	0	3	Tomlin, Mr. Ernest Portage	male	30.5	0	0	364499	8.05	\N	S	1259	Tomlin, Mr. Ernest Portage	22	Portage la Prairie, Manitoba, Canada	Southampton	Des Moines, Iowa, US	\N	50MB	3
816	0	1	Fry, Mr. Richard	male	\N	0	0	112058	0	B102	S	171	and valet, Mr. John Richard Fry	39	Liverpool, Merseyside, England, UK	Southampton	New York, New York, US	\N	\N	1
817	0	3	Heininen, Miss. Wendla Maria	female	23	0	0	STON/O2. 3101290	7.925	\N	S	866	Heininen, Miss Wendla Maria	23	Turku, Finland	Southampton	New York City	\N	8MB	3
818	0	2	Mallet, Mr. Albert	male	31	1	1	S.C./PARIS 2079	37.0042	\N	C	499	Mallet, Mr. Albert	31	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	\N	\N	2
819	0	3	Holm, Mr. John Fredrik Alexander	male	43	0	0	C 7075	6.45	\N	S	873	Holm, Mr. Johan Fredrik Alexander	43	Karlshamn, Blekinge, Sweden	Southampton	New York City	\N	\N	3
820	0	3	Skoog, Master. Karl Thorsten	male	10	3	2	347088	27.9	\N	S	1216	Skoog, Master Karl Thorsten	11	Hällekis, Västergötland, Sweden	Southampton	Iron Mountain, Michigan, US	\N	\N	3
821	1	1	Hays, Mrs. Charles Melville (Clara Jennings Gregg)	female	52	1	1	12749	93.5	B69	S	154	Hays, Mrs. Clara Jennings (née Grigg)	52	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	3	\N	1
822	1	3	Lulic, Mr. Nikola	male	27	0	0	315098	8.6625	\N	S	986	Lulić, Mr. Nikola	29	Konjsko Brdo, Croatia	Southampton	Chicago, Illinois, US	15	\N	3
823	0	1	Reuchlin, Jonkheer. John George	male	38	0	0	19972	0	\N	S	233	Reuchlin, The Honourable Mr. Johan George	38	Rotterdam, The Netherlands	Southampton	New York, New York, US	\N	\N	1
824	1	3	Moor, Mrs. (Beila)	female	27	0	1	392096	12.475	E121	S	1034	Moor, Mrs. Beila	29	Unknown, Russia	Southampton	Chicago, Illinois, US	14	\N	3
825	0	3	Panula, Master. Urho Abraham	male	2	4	1	3101295	39.6875	\N	S	1113	Panula, Master Urho Abraham	2	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
826	0	3	Flynn, Mr. John	male	\N	0	0	368323	6.95	\N	Q	810	Flynn, Mr. John	42	Clonbur, Galway, Ireland	Queenstown	Pittsburgh, Pennsylvania, US	\N	\N	3
827	0	3	Lam, Mr. Len	male	\N	0	0	1601	56.4958	\N	S	953	Lam, Mr. Len	23	Hong Kong, China	Southampton	New York City	\N	\N	3
828	1	2	Mallet, Master. Andre	male	1	0	2	S.C./PARIS 2079	37.0042	\N	C	501	Mallet, Master André Clément	1	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	10	\N	2
829	1	3	McCormack, Mr. Thomas Joseph	male	\N	0	0	367228	7.75	\N	Q	1007	McCormack, Mr. Thomas Joseph	19	Bayonne, New Jersey, US	Queenstown	Guttenberg, New Jersey, US	15	\N	3
830	1	1	Stone, Mrs. George Nelson (Martha Evelyn)	female	62	0	0	113572	80	B28	\N	283	Stone, Mrs. Martha Evelyn (née Stevens)	62	New York, New York, US	Southampton	New York, New York, US	6	\N	1
831	1	3	Yasbeck, Mrs. Antoni (Selini Alexander)	female	15	1	0	2659	14.4542	\N	C	1307	Yasbak, Mrs. Silanah Fa'ud (née Iskandar)	15	Unknown, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	C	\N	3
832	1	2	Richards, Master. George Sibley	male	0.83	1	1	29106	18.75	\N	S	555	Richards, Master Sibley George	0.75	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	4	\N	2
833	0	3	Saad, Mr. Amin	male	\N	0	0	2671	7.2292	\N	C	1170	Saad, Mr. Amin	30	Tebnine, Lebanon	Cherbourg	New York City	\N	\N	3
834	0	3	Augustsson, Mr. Albert	male	23	0	0	347468	7.8542	\N	S	660	Augustsson, Mr. Albert	23	Krakoryd, Småland, Sweden	Southampton	Bloomington, Indiana, US	\N	\N	3
835	0	3	Allum, Mr. Owen George	male	18	0	0	2223	8.3	\N	S	628	Allum, Mr. Owen George	15	Southall, London, England	Southampton	New York City	\N	259MB	3
836	1	1	Compton, Miss. Sara Rebecca	female	39	1	1	PC 17756	83.1583	E49	C	82	Compton, Miss Sara Rebecca	39	Lakewood, New Jersey, US	Cherbourg	Lakewood, New Jersey, US	14	\N	1
837	0	3	Pasic, Mr. Jakob	male	21	0	0	315097	8.6625	\N	S	1115	Pašič, Mr. Jakov	21	Streklevac, Slovenia	Southampton	Aurora, Illinois, US	\N	\N	3
838	0	3	Sirota, Mr. Maurice	male	\N	0	0	392092	8.05	\N	S	1210	Sirota, Mr. Maurice	20	London, England	Southampton	New York City	\N	\N	3
839	1	3	Chip, Mr. Chang	male	32	0	0	1601	56.4958	\N	S	720	Chang, Mr. Chip	32	Hong Kong, China	Southampton	New York City	C	\N	3
840	1	1	Marechal, Mr. Pierre	male	\N	0	0	11774	29.7	C47	C	195	Maréchal, Mr. Pierre, Sr.	28	Paris, France	Cherbourg	New York, New York, US	7	\N	1
841	0	3	Alhomaki, Mr. Ilmari Rudolf	male	20	0	0	SOTON/O2 3101287	7.925	\N	S	624	Alhomäki, Mr. Ilmari Rudolf	19	Salo, Finland	Southampton	Astoria, Oregon, US	\N	\N	3
842	0	2	Mudd, Mr. Thomas Charles	male	16	0	0	S.O./P.P. 3	10.5	\N	S	517	Mudd, Mr. Thomas Charles	16	Huntingfield, Suffolk, England	Southampton	New York City	\N	\N	2
843	1	1	Serepeca, Miss. Augusta	female	30	0	0	113798	31	\N	C	61	and maid, Miss Auguste Serreplan	30	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	4	\N	1
844	0	3	Lemberopolous, Mr. Peter L	male	34.5	0	0	2683	6.4375	\N	C	989	Lymperopoulus, Mr. Panagiotis K.	30	Áyios Sóstis, Greece	Cherbourg	Stamford, Connecticut US	\N	196MB	3
845	0	3	Culumovic, Mr. Jeso	male	17	0	0	315090	8.6625	\N	S	749	Čulumović, Mr. Jeso	17	Lipova Glavica, Croatia	Southampton	Hammond, Indiana, US	\N	\N	3
846	0	3	Abbing, Mr. Anthony	male	42	0	0	C.A. 5547	7.55	\N	S	608	Abbing, Mr. Anthony	40	Cincinnati, Ohio, US	Southampton	Cincinnati, Ohio, US	\N	\N	3
847	0	3	Sage, Mr. Douglas Bullen	male	\N	8	2	CA. 2343	69.55	\N	S	1178	Sage, Mr. Douglas Bullen	18	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
848	0	3	Markoff, Mr. Marin	male	35	0	0	349213	7.8958	\N	C	1003	Markoff, Mr. Marin	35	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
849	0	2	Harper, Rev. John	male	28	0	1	248727	33	\N	S	434	Harper, The Reverend John	39	London, England	Southampton	Chicago, Illinois, US	\N	\N	2
850	1	1	Goldenberg, Mrs. Samuel L (Edwiga Grabowska)	female	\N	1	0	17453	89.1042	C92	C	132	Goldenberg, Mrs. Nella (née Wiggins)	40	Paris, France	Cherbourg	New York, New York, US	5	\N	1
851	0	3	Andersson, Master. Sigvard Harald Elias	male	4	4	2	347082	31.275	\N	S	637	Andersson, Master Sigvard Harald Elias	4	Kisa, Östergötland, Sweden	Southampton	Winnipeg, Manitoba, Canada	\N	\N	3
852	0	3	Svensson, Mr. Johan	male	74	0	0	347060	7.775	\N	S	1243	Svensson, Mr. Johan	74	Reftele, Småland, Sweden	Southampton	Effington Rut, South Dakota, US	\N	\N	3
853	0	3	Boulos, Miss. Nourelain	female	9	1	1	2678	15.2458	\N	C	698	Bulus, Miss Nur-al-Ayn	7	Unknown, Lebanon	Cherbourg	Kent, British Columbia, Canada	\N	\N	3
854	1	1	Lines, Miss. Mary Conover	female	16	0	1	PC 17592	39.4	D28	S	189	Lines, Miss Mary Conover	16	Paris, France	Cherbourg	Hanover, New Hampshire, US	9	\N	1
855	0	2	Carter, Mrs. Ernest Courtenay (Lilian Hughes)	female	44	1	0	244252	26	\N	S	371	Carter, Mrs. Lilian (née Hughes)	45	London, England, UK	Southampton	New York City	\N	\N	2
856	1	3	Aks, Mrs. Sam (Leah Rosen)	female	18	0	1	392091	9.35	\N	S	620	Aks, Mrs. Leah (née Rosen)	18	London, England	Southampton	Norfolk, Virginia, US	13	\N	3
857	1	1	Wick, Mrs. George Dennick (Mary Hitchcock)	female	45	1	1	36928	164.8667	\N	S	314	Wick, Mrs. Mary (née Hitchcock)	45	Youngstown, Ohio, US	Southampton	Youngstown, Ohio, US	8	\N	1
858	1	1	Daly, Mr. Peter Denis 	male	51	0	0	113055	26.55	E17	S	91	Daly, Mr. Peter Dennis	51	Lima, Peru	Southampton	Lima, Peru	A	\N	1
859	1	3	Baclini, Mrs. Solomon (Latifa Qurban)	female	24	0	3	2666	19.2583	\N	C	669	Baqlini, Mrs. Mariyam Latifa (née Qurban)	24	Ḑuhūr ash Shuwayr, Lebanon	Cherbourg	Brooklyn, New York, US	C	\N	3
860	0	3	Razi, Mr. Raihed	male	\N	0	0	2629	7.2292	\N	C	1142	Razi, Mr. Raihed	30	Tebnine, Lebanon	Cherbourg	New York City	\N	\N	3
861	0	3	Hansen, Mr. Claus Peter	male	41	2	0	350026	14.1083	\N	S	855	Hansen, Mr. Claus Peter	41	Racine, Wisconsin, US	Southampton	Racine, Wisconsin, US	\N	\N	3
862	0	2	Giles, Mr. Frederick Edward	male	21	1	0	28134	11.5	\N	S	424	Giles, Mr. Frederick Edward	20	Porthleven, Cornwall, England	Southampton	Camden, New Jersey, US	\N	\N	2
863	1	1	Swift, Mrs. Frederick Joel (Margaret Welles Barron)	female	48	0	0	17466	25.9292	D17	S	290	Swift, Mrs. Margaret Welles (née Barron)	46	New York, New York, US	Southampton	New York, New York, US	8	\N	1
864	0	3	Sage, Miss. Dorothy Edith "Dolly"	female	\N	8	2	CA. 2343	69.55	\N	S	1180	Sage, Miss Dorothy Florence "Dolly"	14	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
865	0	2	Gill, Mr. John William	male	24	0	0	233866	13	\N	S	426	Gill, Mr. John William	24	Clevedon, North Somerset England	Southampton	New York City	\N	155MB	2
866	1	2	Bystrom, Mrs. (Karolina)	female	42	0	0	236852	13	\N	S	363	Byström, Miss Karolina	42	New York City	Southampton	New York City	?	\N	2
867	1	2	Duran y More, Miss. Asuncion	female	27	1	0	SC/PARIS 2149	13.8583	\N	C	407	Duran y More, Miss Asunción	27	Barcelona, Catalonia, Spain	Cherbourg	Havana, Cuba	12	\N	2
868	0	1	Roebling, Mr. Washington Augustus II	male	31	0	0	PC 17590	50.4958	A24	S	237	Roebling, Mr. Washington Augustus II	31	Trenton, New Jersey, US	Southampton	Trenton, New Jersey, US	\N	\N	1
869	0	3	van Melkebeke, Mr. Philemon	male	\N	0	0	345777	9.5	\N	S	1277	Van Melkebeke, Mr. Philemon Edmund	23	Haaltert, East Flanders, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
870	1	3	Johnson, Master. Harold Theodor	male	4	1	1	347742	11.1333	\N	S	903	Johnson, Master Harold Theodor	4	St. Charles, Illinois, US	Southampton	St. Charles, Illinois, US	15	\N	3
871	0	3	Balkic, Mr. Cerin	male	26	0	0	349248	7.8958	\N	S	667	Bakić, Mr. Kerim	26	Bosanska Krupa, Bosnia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
872	1	1	Beckwith, Mrs. Richard Leonard (Sallie Monypeny)	female	47	1	1	11751	52.5542	D35	S	27	Beckwith, Mrs. Sallie (née Monypeny)	46	New York, New York, US	Southampton	New York, New York, US	5	\N	1
873	0	1	Carlsson, Mr. Frans Olof	male	33	0	0	695	5	B51 B53 B55	S	54	Carlsson, Mr. Frans Olof	33	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
874	0	3	Vander Cruyssen, Mr. Victor	male	47	0	0	345765	9	\N	S	1278	Vandercruyssen, Mr. Victor	46	Zwevezele, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
875	1	2	Abelson, Mrs. Samuel (Hannah Wizosky)	female	28	1	0	P/PP 3381	24	\N	C	328	Abelson, Mrs. Anna (née Wizosky?)	28	Russia	Cherbourg	New York, New York, US	10	\N	2
876	1	3	Najib, Miss. Adele Kiamie "Jane"	female	15	0	0	2667	7.225	\N	C	1311	Zajib Qiyamah, Miss Adal "Jane"	15	El Shweir, Lebanon	Cherbourg	Brooklyn, New York, US	C	\N	3
877	0	3	Gustafsson, Mr. Alfred Ossian	male	20	0	0	7534	9.8458	\N	S	842	Gustafsson, Mr. Alfred Ossian	19	Kokkola, Finland	Southampton	Waukegan, Illinois, US	\N	\N	3
878	0	3	Petroff, Mr. Nedelio	male	19	0	0	349212	7.8958	\N	S	1131	Petroff, Mr. Nadjalko	19	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
879	0	3	Laleff, Mr. Kristo	male	\N	0	0	349217	7.8958	\N	S	951	Laleff, Mr. Kristo	23	Knezhni Lak, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
880	1	1	Potter, Mrs. Thomas Jr (Lily Alexenia Wilson)	female	56	0	1	11767	83.1583	C50	C	232	Potter, Mrs. Lily Alexenia (née Wilson)	56	Philadelphia, Pennsylvania, US	Cherbourg	Philadelphia, Pennsylvania, US	7	\N	1
881	1	2	Shelley, Mrs. William (Imanita Parrish Hall)	female	25	0	1	230433	26	\N	S	563	Shelley, Mrs. Imanita (née Parrish Hall)	25	Deer Lodge, Montana, US	Southampton	Deer Lodge, Montana, US	12	\N	2
882	0	3	Markun, Mr. Johann	male	33	0	0	349257	7.8958	\N	S	1004	Markun, Mr. Johann	33	Milje, Slovenia	Cherbourg	New York City	\N	\N	3
883	0	3	Dahlberg, Miss. Gerda Ulrika	female	22	0	0	7552	10.5167	\N	S	752	Dahlberg, Miss Gerda Ulrika	22	Stockholm, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
884	0	2	Banfield, Mr. Frederick James	male	28	0	0	C.A./SOTON 34068	10.5	\N	S	337	Banfield, Mr. Frederick James	28	Plymouth, Devon, England	Southampton	Houghton, Michigan, US	\N	\N	2
885	0	3	Sutehall, Mr. Henry Jr	male	25	0	0	SOTON/OQ 392076	7.05	\N	S	1242	Sutehall Jr., Mr. Henry	25	London, England	Southampton	Buffalo, New York, US	\N	\N	3
886	0	3	Rice, Mrs. William (Margaret Norton)	female	39	0	5	382652	29.125	\N	Q	1146	Rice, Mrs. Margaret (née Norton)	39	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	12MB	3
887	0	2	Montvila, Rev. Juozas	male	27	0	0	211536	13	\N	S	514	Montvila, Father Juozas	27	Gudinė, Lithuania [76]	Southampton	Worcester, Massachusetts, US	\N	\N	2
888	1	1	Graham, Miss. Margaret Edith	female	19	0	0	112053	30	B42	S	137	Graham, Miss Margaret Edith	19	Greenwich, Connecticut, US	Southampton	Greenwich, Connecticut, US	3	\N	1
889	0	3	Johnston, Miss. Catherine Helen "Carrie"	female	\N	1	2	W./C. 6607	23.45	\N	S	910	Johnston, Miss Catherine Nellie	7	Thornton Heath, London, England	Southampton	New London, Connecticut, US	\N	\N	3
890	1	1	Behr, Mr. Karl Howell	male	26	0	0	111369	30	C148	C	28	Behr, Mr. Karl Howell	26	New York, New York, US	Cherbourg	New York, New York, US	5	\N	1
891	0	3	Dooley, Mr. Patrick	male	32	0	0	370376	7.75	\N	Q	783	Dooley, Mr. Patrick J.	43	Patrickswell, Limerick, Ireland	Queenstown	New York City	\N	\N	3
892	\N	3	Kelly, Mr. James	male	34.5	0	0	330911	7.8292	\N	Q	928	Kelly, Mr. James	19	Unknown, Ireland	Southampton	New York City	\N	70MB	3
893	\N	3	Wilkes, Mrs. James (Ellen Needs)	female	47	1	0	363272	7	\N	S	1297	Wilkes, Mrs. Ellen	47	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	16	\N	3
894	\N	2	Myles, Mr. Thomas Francis	male	62	0	0	240276	9.6875	\N	Q	518	Myles, Mr. Thomas Francis	63	Fermoy, Ireland[note 1]	Queenstown	Waban, Massachusetts, US	\N	\N	2
895	\N	3	Wirz, Mr. Albert	male	27	0	0	315154	8.6625	\N	S	1303	Wirz, Mr. Albert	27	Uster, Switzerland	Southampton	Beloit, Wisconsin, US	\N	131MB	3
896	\N	3	Hirvonen, Mrs. Alexander (Helga E Lindqvist)	female	22	1	1	3101298	12.2875	\N	S	871	Hirvonen, Mrs. Helga Elisabeth (née Lindqvist)	22	Taalintehdas, Finland	Southampton	Monessen, Pennsylvania, US	15	\N	3
897	\N	3	Svensson, Mr. Johan Cervin	male	14	0	0	7538	9.225	\N	S	1244	Svensson, Mr. Johan Cervin	14	Knäred, Halland, Sweden	Southampton	Beresford, South Dakota, US	13	\N	3
898	\N	3	Connolly, Miss. Kate	female	30	0	0	330972	7.6292	\N	Q	733	Connolly, Miss Catherine "Kate"	35	Bank Place, Tipperary, Ireland	Queenstown	Dobbs Ferry, New York, US	\N	\N	3
899	\N	2	Caldwell, Mr. Albert Francis	male	26	1	1	248738	29	\N	S	364	Caldwell, Mr. Albert Francis	26	Bangkok, Siam[note 5]	Southampton	Roseville, Illinois, US	13	\N	2
900	\N	3	Abrahim, Mrs. Joseph (Sophie Halaut Easu)	female	18	0	0	2657	7.2292	\N	C	616	Abrahim, Mrs. Mary Sophie Halaut (née Easu)	18	Shwayhad, Syria	Cherbourg	Greensburg, Pennsylvania, US	C	\N	3
901	\N	3	Davies, Mr. John Samuel	male	21	2	0	A/4 48871	24.15	\N	S	763	Davies, Mr. John Samuel	21	West Bromwich, Staffordshire, England	Southampton	Pontiac, Michigan, US	\N	\N	3
902	\N	3	Ilieff, Mr. Ylio	male	\N	0	0	349220	7.8958	\N	S	1308	Ylieff, Mr. Ylio	32	Unknown, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
903	\N	1	Jones, Mr. Charles Cresson	male	46	0	0	694	26	\N	S	173	Jones, Mr. Charles Cresson	46	Bennington, Vermont, US	Southampton	Bennington, Vermont, US	\N	80MB	1
904	\N	1	Snyder, Mrs. John Pillsbury (Nelle Stevenson)	female	23	1	0	21228	82.2667	B45	S	268	Snyder, Mrs. Nellie (née Stevenson)	23	Minneapolis, Minnesota, US	Southampton	Minneapolis, Minnesota, US	7	\N	1
905	\N	2	Howard, Mr. Benjamin	male	63	1	0	24065	26	\N	S	460	Howard, Mr. Benjamin	63	Swindon, Wiltshire, England	Southampton	Idaho, US	\N	\N	2
906	\N	1	Chaffee, Mrs. Herbert Fuller (Carrie Constance Toogood)	female	47	1	0	W.E.P. 5734	61.175	E31	S	70	Chaffee, Mrs. Carrie Constance (née Toogood)	47	Amenia, North Dakota, US	Southampton	Amenia, North Dakota, US	4	\N	1
907	\N	2	del Carlo, Mrs. Sebastiano (Argenia Genovesi)	female	24	1	0	SC/PARIS 2167	27.7208	\N	C	397	del Carlo, Mrs. Argene (née Genovesi)[62][74]	24	Montecarlo, Lucca, Tuscany, Italy	Cherbourg	Chicago, Illinois, US	11	\N	2
908	\N	2	Keane, Mr. Daniel	male	35	0	0	233734	12.35	\N	Q	475	Keane, Mr. Daniel	35	Limerick, Ireland[note 1]	Queenstown	St Louis, Missouri, US	\N	\N	2
909	\N	3	Assaf, Mr. Gerios	male	21	0	0	2692	7.225	\N	C	822	Gerios Thamah, Mr. Assaf	21	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	\N	\N	3
910	\N	3	Ilmakangas, Miss. Ida Livija	female	27	1	0	STON/O2. 3101270	7.925	\N	S	881	Ilmakangas, Miss Ida Livija	27	New York City, New York, US	Southampton	New York City	\N	\N	3
911	\N	3	Assaf Khalil, Mrs. Mariana (Miriam")"	female	45	0	0	2696	7.225	\N	C	656	Assaf, Mrs. Mariyam (née Khalil)	45	Kafr Mishki, Lebanon	Cherbourg	Ottawa, Ontario, Canada	C	\N	3
912	\N	1	Rothschild, Mr. Martin	male	55	1	0	PC 17603	59.4	\N	C	243	Rothschild, Mr. Martin	46	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
913	\N	3	Olsen, Master. Artur Karl	male	9	0	1	C 17368	3.1708	\N	S	1094	Olsen, Master Arthur Carl	9	Trondheim, Norway	Southampton	Brooklyn, New York, US	13	\N	3
914	\N	1	Flegenheim, Mrs. Alfred (Antoinette)	female	\N	0	0	PC 17598	31.6833	\N	S	110	Flegenheim, Mrs. Antoinette (née Wendt)	48	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
915	\N	1	Williams, Mr. Richard Norris II	male	21	0	1	PC 17597	61.3792	\N	C	323	Williams, Mr. Richard Norris II	21	Geneva, Switzerland	Cherbourg	Radnor, Pennsylvania, US	A	\N	1
916	\N	1	Ryerson, Mrs. Arthur Larned (Emily Maria Borie)	female	48	1	3	PC 17608	262.375	B57 B59 B63 B66	C	247	Ryerson, Mrs. Emily Maria (née Borie)	48	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
917	\N	3	Robins, Mr. Alexander A	male	50	1	0	A/5. 3337	14.5	\N	S	1157	Robins, Mr. Alexander A.	50	St Austell, Cornwall, England	Southampton	Yonkers, New York, US	\N	119MB	3
918	\N	1	Ostby, Miss. Helene Ragnhild	female	22	0	1	113509	61.9792	B36	C	221	Ostby, Miss Helene Ragnhild	22	Providence, Rhode Island, US	Southampton	Providence, Rhode Island, US	5	\N	1
919	\N	3	Daher, Mr. Shedid	male	22.5	0	0	2698	7.225	\N	C	1203	Shadid, Mr. Dahir Abu	19	Ibrin[85], Syria or Lebanon	Cherbourg	Kulpmont, Pennsylvania, US	\N	9MB	3
920	\N	1	Brady, Mr. John Bertram	male	41	0	0	113054	30.5	A21	S	39	Brady, Mr. John Bertram	41	Pomeroy, Washington, US	Southampton	Pomeroy, Washington, US	\N	\N	1
921	\N	3	Samaan, Mr. Elias	male	\N	2	0	2662	21.6792	\N	C	1190	Sa'maan, Mr. Ilyas	17	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	\N	\N	3
922	\N	2	Louch, Mr. Charles Alexander	male	50	1	0	SC/AH 3085	26	\N	S	495	Louch, Mr. Charles Alexander	50	Weston-super-Mare, North Somerset, England	Southampton	New York City	\N	121MB	2
923	\N	2	Jefferys, Mr. Clifford Thomas	male	24	2	0	C.A. 31029	31.5	\N	S	468	Jefferys, Mr. Clifford Thomas	24	Guernsey, Channel Islands	Southampton	Elizabeth, New Jersey, US	\N	\N	2
924	\N	3	Dean, Mrs. Bertram (Eva Georgetta Light)	female	33	1	2	C.A. 2315	20.575	\N	S	771	Dean, Mrs. Eva Georgetta (née Light)	32	Bartley Farm, Hampshire, England	Southampton	Wichita, Kansas, US	10	\N	3
925	\N	3	Johnston, Mrs. Andrew G (Elizabeth Lily" Watson)"	female	\N	1	2	W./C. 6607	23.45	\N	S	908	Johnston, Mrs. Elizabeth (née Watson) "Eliza"	34	Thornton Heath, London, England	Southampton	New London, Connecticut, US	\N	\N	3
926	\N	1	Mock, Mr. Philipp Edmund	male	30	1	0	13236	57.75	C78	C	208	Mock, Mr. Philipp Edmund	30	New York, New York, US	Cherbourg	New York, New York, US	11	\N	1
927	\N	3	Katavelas, Mr. Vassilios (Catavelas Vassilios")"	male	18.5	0	0	2682	7.2292	\N	C	925	Katavelos, Mr. Vassilios G.	19	Agios Sostis, Greece	Cherbourg	Milwaukee, Wisconsin, US	\N	58MB	3
928	\N	3	Roth, Miss. Sarah A	female	\N	0	0	342712	8.05	\N	S	1164	Roth, Miss Sarah A.	26	London, England	Southampton	New York City	C	\N	3
929	\N	3	Cacic, Miss. Manda	female	21	0	0	315087	8.6625	\N	S	707	Čačić, Miss Manda	21	Široka Kula, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
930	\N	3	Sap, Mr. Julius	male	25	0	0	345768	9.5	\N	S	1195	Sap, Mr. Julius (Jules)	21	Zwevezele, Belgium	Southampton	Detroit, Michigan, US	11	\N	3
931	\N	3	Hee, Mr. Ling	male	\N	0	0	1601	56.4958	\N	S	961	Lee, Mr. Ling	28	Hong Kong, China	Southampton	New York City	\N	\N	3
932	\N	3	Karun, Mr. Franz	male	39	0	1	349256	13.4167	\N	C	923	Karun, Mr. Franz	39	Milje, Slovenia	Southampton	Galesburg, Illinois, US	15	\N	3
933	\N	1	Franklin, Mr. Thomas Parham	male	\N	0	0	113778	26.55	D34	S	119	Franklin, Mr. Thomas Parnham	37	London, England, UK	Southampton	New York, New York, US	\N	\N	1
934	\N	3	Goldsmith, Mr. Nathan	male	41	0	0	SOTON/O.Q. 3101263	7.85	\N	S	830	Goldsmith, Mr. Nathan	41	Unknown, Russia	Southampton	Philadelphia, Pennsylvania, US	\N	\N	3
935	\N	2	Corbett, Mrs. Walter H (Irene Colvin)	female	30	0	0	237249	13	\N	S	387	Corbett, Mrs. Irene (née Colvin)	30	Provo, Utah, US	Southampton	Provo, Utah, US	\N	\N	2
936	\N	1	Kimball, Mrs. Edwin Nelson Jr (Gertrude Parsons)	female	45	1	0	11753	52.5542	D19	S	179	Kimball, Mrs. Gertrude (née Parsons)	45	Boston, Massachusetts, US	Southampton	Boston, Massachusetts, US	5	\N	1
937	\N	3	Peltomaki, Mr. Nikolai Johannes	male	25	0	0	STON/O 2. 3101291	7.925	\N	S	1125	Peltomäki, Mr. Nikolai Johannes	25	Helsinki, Finland	Southampton	New York City	\N	\N	3
938	\N	1	Chevre, Mr. Paul Romaine	male	45	0	0	PC 17594	29.7	A9	C	74	Chevré, Mr. Paul Romaine Marie Léonce	45	Paris, France	Cherbourg	Ottawa, Ontario, Canada	7	\N	1
939	\N	3	Shaughnessy, Mr. Patrick	male	\N	0	0	370374	7.75	\N	Q	1201	Shaughnessy, Mr. Patrick	24	Tynagh, Galway, Ireland	Queenstown	New York City	\N	\N	3
940	\N	1	Bucknell, Mrs. William Robert (Emma Eliza Ward)	female	60	0	0	11813	76.2917	D15	C	45	Bucknell, Mrs. Emma Eliza (née Ward)	59	Philadelphia, Pennsylvania, US	Cherbourg	Philadelphia, Pennsylvania, US	8	\N	1
941	\N	3	Coutts, Mrs. William (Winnie Minnie" Treanor)"	female	36	0	2	C.A. 37671	15.9	\N	S	742	Coutts, Mrs. Mary Winnie (née Trainer)	36	London, England	Southampton	Brooklyn, New York, US	2	\N	3
942	\N	1	Smith, Mr. Lucien Philip	male	24	1	0	13695	60	C31	S	264	Smith, Mr. Lucien Philip	24	Huntington, West Virginia, US	Cherbourg	Huntington, West Virginia, US	\N	\N	1
943	\N	2	Pulbaum, Mr. Franz	male	27	0	0	SC/PARIS 2168	15.0333	\N	C	544	Pulbaum, Mr. Franz	27	New York City	Southampton	New York City	\N	\N	2
944	\N	2	Hocking, Miss. Ellen Nellie""	female	20	2	1	29105	23	\N	S	453	Hocking, Miss Ellen "Nellie"	20	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	4	\N	2
945	\N	1	Fortune, Miss. Ethel Flora	female	28	3	2	19950	263	C23 C25 C27	S	115	Fortune, Miss Ethel Flora	28	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	10	\N	1
946	\N	2	Mangiavacchi, Mr. Serafino Emilio	male	\N	0	0	SC/A.3 2861	15.5792	\N	C	502	Mangiavacchi, Mr. Serafino Emilio	30	Paris, France	Cherbourg	New York City	\N	\N	2
947	\N	3	Rice, Master. Albert	male	10	4	1	382652	29.125	\N	Q	1147	Rice, Master Albert	10	Athlone, Westmeath, Ireland	Queenstown	Spokane, Washington, US	\N	\N	3
948	\N	3	Cor, Mr. Bartol	male	35	0	0	349230	7.8958	\N	S	737	Čor, Mr. Bartol	35	Kricina, Croatia	Southampton	Great Falls, Montana, US	\N	\N	3
949	\N	3	Abelseth, Mr. Olaus Jorgensen	male	25	0	0	348122	7.65	F G63	S	614	Abelseth, Mr. Olaus Jørgensen	25	Perkins County, South Dakota, US	Southampton	Perkins County, South Dakota, US	A	\N	3
950	\N	3	Davison, Mr. Thomas Henry	male	\N	1	0	386525	16.1	\N	S	765	Davison, Mr. Thomas Henry "Harry"	32	Liverpool, Merseyside, England	Southampton	Bedford, Indiana, US	\N	\N	3
951	\N	1	Chaudanson, Miss. Victorine	female	36	0	0	PC 17608	262.375	B61	C	248	and maid, Miss Victorine Chaudanson	36	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
952	\N	3	Dika, Mr. Mirko	male	17	0	0	349232	7.8958	\N	S	779	Dika, Mr. Mirko	17	Podgora, Croatia	Southampton	Vancouver, British Columbia, Canada	\N	\N	3
953	\N	2	McCrae, Mr. Arthur Gordon	male	32	0	0	237216	13.5	\N	S	505	McCrae, Mr. Arthur Gordon	32	Sydney, New South Wales, Australia	Southampton	Canada	\N	209MB	2
954	\N	3	Bjorklund, Mr. Ernst Herbert	male	18	0	0	347090	7.75	\N	S	682	Björklund, Mr. Ernst Herbert	18	Stockholm, Sweden	Southampton	New York City	\N	\N	3
955	\N	3	Bradley, Miss. Bridget Delia	female	22	0	0	334914	7.725	\N	Q	688	Bradley, Miss Bridget Delia	22	Kingwilliamstown, Cork, Ireland	Queenstown	Glen Falls, New York, US	13	\N	3
956	\N	1	Ryerson, Master. John Borie	male	13	2	2	PC 17608	262.375	B57 B59 B63 B66	C	251	Ryerson, Master John Borie "Jack"	13	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
957	\N	2	Corey, Mrs. Percy C (Mary Phyllis Elizabeth Miller)	female	\N	0	0	F.C.C. 13534	21	\N	S	388	Corey, Mrs. Mary Phyllis Elizabeth (née Miller)	30	Pittsburgh, Pennsylvania, US	Southampton	Pittsburgh, Pennsylvania, US	\N	\N	2
958	\N	3	Burns, Miss. Mary Delia	female	18	0	0	330963	7.8792	\N	Q	700	Burns, Miss Mary Delia	17	Kilmacowen, Sligo, Ireland	Queenstown	New York City	\N	\N	3
959	\N	1	Moore, Mr. Clarence Bloomfield	male	47	0	0	113796	42.4	\N	S	210	Moore, Mr. Clarence Bloomfield	47	Washington, DC, US	Southampton	Washington, DC, US	\N	\N	1
960	\N	1	Tucker, Mr. Gilbert Milligan Jr	male	31	0	0	2543	28.5375	C53	C	301	Tucker, Mr. Gilbert Milligan Jr.	31	Albany, New York, US	Cherbourg	Albany, New York, US	7	\N	1
961	\N	1	Fortune, Mrs. Mark (Mary McDougald)	female	60	1	4	19950	263	C23 C25 C27	S	114	Fortune, Mrs. Mary (née McDougald)	60	Winnipeg, Manitoba, Canada	Southampton	Winnipeg, Manitoba, Canada	10	\N	1
962	\N	3	Mulvihill, Miss. Bertha E	female	24	0	0	382653	7.75	\N	Q	1048	Mulvihill, Miss Bridget Elizabeth "Bertha"	25	Athlone, Westmeath, Ireland	Queenstown	Providence, Rhode Island, US	15	\N	3
963	\N	3	Minkoff, Mr. Lazar	male	21	0	0	349211	7.8958	\N	S	1030	Minkoff, Mr. Lazar	21	Gumostnik, Lovec, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
964	\N	3	Nieminen, Miss. Manta Josefina	female	29	0	0	3101297	7.925	\N	S	1066	Nieminen, Miss Manta Josefiina	29	Karinainen, Finland	Southampton	Aberdeen, Washington, US	\N	\N	3
965	\N	1	Ovies y Rodriguez, Mr. Servando	male	28.5	0	0	PC 17562	27.7208	D43	C	222	Ovies y Rodriguez, Mr. Servando José Florentino	36	Havana, Cuba	Cherbourg	Havana, Cuba	\N	189MB	1
966	\N	1	Geiger, Miss. Amalie	female	35	0	0	113503	211.5	C130	C	319	and maid, Miss Amalie Henriette "Emily" Gieger	35	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	4	\N	1
967	\N	1	Keeping, Mr. Edwin	male	32.5	0	0	113503	211.5	C132	C	317	and valet, Mr. Edwin Herbert Keeping	33	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	\N	45MB	1
968	\N	3	Miles, Mr. Frank	male	\N	0	0	359306	8.05	\N	S	1028	Miles, Mr. Frank	23	Greenwich, London, England	Southampton	New York City	\N	\N	3
969	\N	1	Cornell, Mrs. Robert Clifford (Malvina Helen Lamson)	female	55	2	0	11770	25.7	C101	S	84	Cornell, Mrs. Malvina Helen (née Lamson)	55	New York, New York, US	Southampton	New York, New York, US	2	\N	1
970	\N	2	Aldworth, Mr. Charles Augustus	male	30	0	0	248744	13	\N	S	59	and chauffeur, Mr. Charles Augustus Aldworth[59]	30	Bryn Mawr, Pennsylvania, US	Southampton	Bryn Mawr, Pennsylvania, US	\N	\N	1
971	\N	3	Doyle, Miss. Elizabeth	female	24	0	0	368702	7.75	\N	Q	787	Doyle, Miss Elizabeth	24	Bree, Wexford, Ireland	Queenstown	New York City	\N	\N	3
972	\N	3	Boulos, Master. Akar	male	6	1	1	2678	15.2458	\N	C	697	Bulus, Master Akar	9	Unknown, Lebanon	Cherbourg	Kent, British Columbia, Canada	\N	\N	3
973	\N	1	Straus, Mr. Isidor	male	67	1	0	PC 17483	221.7792	C55 C57	S	285	Straus, Mr. Isidor	67	New York, New York, US	Southampton	New York, New York, US	\N	96MB	1
974	\N	1	Case, Mr. Howard Brown	male	49	0	0	19924	26	\N	S	64	Case, Mr. Howard Brown	49	Ascot, Berkshire, England, UK	Southampton	Rochester, New York, US	\N	\N	1
975	\N	3	Demetri, Mr. Marinko	male	\N	0	0	349238	7.8958	\N	S	1002	Marinko, Mr. Dmitri	23	Unknown, Macedonia	Southampton	New York City	\N	\N	3
976	\N	2	Lamb, Mr. John Joseph	male	\N	0	0	240261	10.7083	\N	Q	484	Lamb, Mr. John Joseph	30	Glencree, Ireland[note 1]	Queenstown	Providence, Rhode Island, US	\N	\N	2
977	\N	3	Khalil, Mr. Betros	male	\N	1	0	2660	14.4542	\N	C	933	Khalil-Khoury, Mr. Butrus	25	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	\N	\N	3
978	\N	3	Barry, Miss. Julia	female	27	0	0	330844	7.8792	\N	Q	675	Barry, Miss Julia	26	New York City, New York, US	Queenstown	New York City	\N	\N	3
979	\N	3	Badman, Miss. Emily Louisa	female	18	0	0	A/4 31416	8.05	\N	S	665	Badman, Miss Emily Louisa	18	Clevedon, North Somerset, England	Southampton	Skaneateles, New York, US	C	\N	3
980	\N	3	O'Donoghue, Ms. Bridget	female	\N	0	0	364856	7.75	\N	Q	782	Donohoe, Miss Bridget	21	Cum, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
981	\N	2	Wells, Master. Ralph Lester	male	2	1	1	29103	23	\N	S	595	Wells, Master Ralph Lester	2	Heamoor, Cornwall, England	Southampton	Akron, Ohio, US	14	\N	2
982	\N	3	Dyker, Mrs. Adolf Fredrik (Anna Elisabeth Judith Andersson)	female	22	1	0	347072	13.9	\N	S	793	Dyker, Mrs. Anna Elisabeth Judith (née Andersson)	22	New Haven, Connecticut, US	Southampton	New Haven, Connecticut, US	16	\N	3
983	\N	3	Pedersen, Mr. Olaf	male	\N	0	0	345498	7.775	\N	S	1122	Pedersen, Mr. Olaf	28	Sandefjord, Norway	Southampton	Seattle, Washington, US	\N	\N	3
984	\N	1	Davidson, Mrs. Thornton (Orian Hays)	female	27	1	2	F.C. 12750	52	B71	S	94	Davidson, Mrs. Orian (née Hays)	27	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	3	\N	1
985	\N	3	Guest, Mr. Robert	male	\N	0	0	376563	8.05	\N	S	841	Guest, Mr. Robert	32	London, England	Southampton	Clinton, New York, US	\N	\N	3
986	\N	1	Birnbaum, Mr. Jakob	male	25	0	0	13905	26	\N	C	29	Birnbaum, Mr. Jakob	24	Antwerp, Belgium	Cherbourg	San Francisco, California, US	\N	148MB	1
987	\N	3	Tenglin, Mr. Gunnar Isidor	male	25	0	0	350033	7.7958	\N	S	1246	Tenglin, Mr. Gunnar Isidor	25	Stockholm, Uppland, Sweden	Southampton	Burlington, Iowa, US	13	\N	3
988	\N	1	Cavendish, Mrs. Tyrell William (Julia Florence Siegel)	female	76	1	0	19877	78.85	C46	S	67	Cavendish, Mrs. Julia Florence (née Siegel)	25	London, England, UK	Southampton	New York, New York, US	6	\N	1
989	\N	3	Makinen, Mr. Kalle Edvard	male	29	0	0	STON/O 2. 3101268	7.925	\N	S	997	Mäkinen, Mr. Kalle Edvard	29	Ikaalinen, Pirkanmaa, Finland	Southampton	Glassport, Pennsylvania, US	\N	\N	3
990	\N	3	Braf, Miss. Elin Ester Maria	female	20	0	0	347471	7.8542	\N	S	689	Braf, Miss Elin Ester Maria	20	Medeltorp, Småland, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
991	\N	3	Nancarrow, Mr. William Henry	male	33	0	0	A./5. 3338	8.05	\N	S	1060	Nancarrow, Mr. William Henry	33	St Austell, Cornwall, England	Southampton	Yonkers, New York, US	\N	\N	3
992	\N	1	Stengel, Mrs. Charles Emil Henry (Annie May Morris)	female	43	1	0	11778	55.4417	C116	C	280	Stengel, Mrs. Annie May (née Morris)	44	Newark, New Jersey, US	Cherbourg	Newark, New Jersey, US	5	\N	1
993	\N	2	Weisz, Mr. Leopold	male	27	1	0	228414	26	\N	S	591	Weisz, Mr. Leopold	28	Bromsgrove, Worcestershire, England	Southampton	Montreal, Quebec, Canada	\N	293MB	2
994	\N	3	Foley, Mr. William	male	\N	0	0	365235	7.75	\N	Q	812	Foley, Mr. William	20	Donoughmore, Cork, Ireland	Queenstown	New York City	\N	\N	3
995	\N	3	Johansson Palmquist, Mr. Oskar Leander	male	26	0	0	347070	7.775	\N	S	900	Johansson Palmquist, Mr. Oskar Leander	26	Kvarnaryd, Småland, Sweden	Southampton	New Haven, Connecticut, US	15	\N	3
996	\N	3	Thomas, Mrs. Alexander (Thamine Thelma")"	female	16	1	1	2625	8.5167	\N	C	1249	Tannous, Mrs. Thamini Khoury Fa'ud "Thelma"	16	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	14	\N	3
997	\N	3	Holthen, Mr. Johan Martin	male	28	0	0	C 4001	22.525	\N	S	874	Holten, Mr. Johan Martin	28	Bergen, Norway	Southampton	New York City	\N	\N	3
998	\N	3	Buckley, Mr. Daniel	male	21	0	0	330920	7.8208	\N	Q	694	Buckley, Mr. Daniel	21	Kingwilliamstown, Cork, Ireland	Queenstown	New York City	13	\N	3
999	\N	3	Ryan, Mr. Edward	male	\N	0	0	383162	7.75	\N	Q	1167	Ryan, Mr. Edward	24	Ballinascreen, Tipperary, Ireland	Queenstown	Troy, New York, US	14	\N	3
1000	\N	3	Willer, Mr. Aaron (Abi Weller")"	male	\N	0	0	3410	8.7125	\N	S	1298	Willer, Mr. Aaron	37	Unknown, Russia	Cherbourg	Chicago, Illinois, US	\N	\N	3
1001	\N	2	Swane, Mr. George	male	18.5	0	0	248734	13	F	S	3	and chauffeur, Mr. George Swane[59]	19	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	294MB	1
1002	\N	2	Stanton, Mr. Samuel Ward	male	41	0	0	237734	15.0458	\N	C	572	Stanton, Mr. Samuel Ward	42	New York City	Southampton	New York City	\N	\N	2
1003	\N	3	Shine, Miss. Ellen Natalia	female	\N	0	0	330968	7.7792	\N	Q	1206	Shine, Miss Ellen Natalia	20	Cork, Cork, Ireland	Queenstown	New York City	?	\N	3
1004	\N	1	Evans, Miss. Edith Corse	female	36	0	0	PC 17531	31.6792	A29	C	109	Evans, Miss Edith Corse	36	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
1005	\N	3	Buckley, Miss. Katherine	female	18.5	0	0	329944	7.2833	\N	Q	695	Buckley, Miss Catherine	22	Ovens, Cork, Ireland	Queenstown	Roxbury, Massachusetts, US	\N	299MB	3
1006	\N	1	Straus, Mrs. Isidor (Rosalie Ida Blun)	female	63	1	0	PC 17483	221.7792	C55 C57	S	287	Straus, Mrs. Rosalie Ida (née Blun)	63	New York, New York, US	Southampton	New York, New York, US	\N	\N	1
1007	\N	3	Chronopoulos, Mr. Demetrios	male	18	1	0	2680	14.4542	\N	C	725	Chronopoulos, Mr. Dimitrios	18	Agios Sostis, Peloponnese, Greece	Cherbourg	New York City	\N	\N	3
1009	\N	3	Sandstrom, Miss. Beatrice Irene	female	1	1	1	PP 9549	16.7	G6	S	1194	Sandström, Miss Beatrice Irene	1	Motala, Östergötland, Sweden	Southampton	San Francisco, US	13	\N	3
1010	\N	1	Beattie, Mr. Thomson	male	36	0	0	13050	75.2417	C6	C	25	Beattie, Mr. Thomson	36	Fergus, Ontario, Canada	Southampton	Fergus, Ontario, Canada	A[64]	331O	1
1011	\N	2	Chapman, Mrs. John Henry (Sara Elizabeth Lawry)	female	29	1	0	SC/AH 29037	26	\N	S	374	Chapman, Mrs. Sara Elizabeth (née Lawry)	28	Liskeard, Cornwall, England	Southampton	Spokane, Washington, US	\N	\N	2
1012	\N	2	Watt, Miss. Bertha J	female	12	0	0	C.A. 33595	15.75	\N	S	589	Watt, Miss Robertha Josephine "Bertha"	12	Aberdeen, Aberdeenshire, Scotland	Southampton	Portland, Oregon, US	9	\N	2
1013	\N	3	Kiernan, Mr. John	male	\N	1	0	367227	7.75	\N	Q	935	Kiernan, Mr. John Joseph	24	Jersey City, New Jersey, US	Queenstown	Jersey City, New Jersey, US	\N	\N	3
1014	\N	1	Schabert, Mrs. Paul (Emma Mock)	female	35	1	0	13236	57.75	C28	C	255	Schabert, Mrs. Emma (née Mock)	35	Hamburg, German Empire[note 2]	Southampton	New York, New York, US	11	\N	1
1015	\N	3	Carver, Mr. Alfred John	male	28	0	0	392095	7.25	\N	S	718	Carver, Mr. Alfred John	28	Southampton, Hampshire, England	Southampton	New York City	\N	\N	3
1016	\N	3	Kennedy, Mr. John	male	\N	0	0	368783	7.75	\N	Q	932	Kennedy, Mr. John Joseph	24	Watergate, Limerick, Ireland	Queenstown	New York City	15?	\N	3
1017	\N	3	Cribb, Miss. Laura Alice	female	17	0	1	371362	16.1	\N	S	748	Cribb, Miss Laura Mae	16	Bournemouth, Dorset, England	Southampton	Newark, New Jersey, US	12	\N	3
1018	\N	3	Brobeck, Mr. Karl Rudolf	male	22	0	0	350045	7.7958	\N	S	692	Brobeck, Mr. Karl Rudolf	22	Norrköping, Östergötland, Sweden	Southampton	Worcester, Massachusetts, US	\N	\N	3
1019	\N	3	McCoy, Miss. Alicia	female	\N	2	0	367226	23.25	\N	Q	1009	McCoy, Miss Alice	26	Carrickatane, Tyrone, Ireland	Queenstown	Brooklyn, New York, US	16	\N	3
1020	\N	2	Bowenur, Mr. Solomon	male	42	0	0	211535	13	\N	S	350	Bowenur, Mr. Solomon	42	London, England	Southampton	New York City	\N	\N	2
1021	\N	3	Petersen, Mr. Marius	male	24	0	0	342441	8.05	\N	S	1129	Petersen, Miss. Abby	24	London, England	Southampton	New York City	\N	\N	3
1022	\N	3	Spinner, Mr. Henry John	male	32	0	0	STON/OQ. 369943	8.05	\N	S	1228	Spinner, Mr. Henry John	32	Arboretum, Worcestershire, England	Southampton	Gloversville, New York, US	\N	\N	3
1023	\N	1	Gracie, Col. Archibald IV	male	53	0	0	113780	28.5	C51	C	134	Gracie IV, Colonel Archibald	53	Washington, DC, US	Southampton	Washington, DC, US	B	\N	1
1024	\N	3	Lefebre, Mrs. Frank (Frances)	female	\N	0	4	4133	25.4667	\N	S	962	Lefebvre, Mrs. Frances Marie-Anselme (née Daumont)	40	Liévin, Pas-de-Calais, France	Southampton	Mystic, Iowa, US	\N	\N	3
1025	\N	3	Thomas, Mr. Charles P	male	\N	1	0	2621	6.4375	\N	C	1248	Tannous, Mr. Bashir (Charles)	31	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	\N	\N	3
1026	\N	3	Dintcheff, Mr. Valtcho	male	43	0	0	349226	7.8958	\N	S	781	Dintcheff, Mr. Valtcho	43	Unknown, Bulgaria	Southampton	Tulsa, Oklahoma, US	\N	\N	3
1027	\N	3	Carlsson, Mr. Carl Robert	male	24	0	0	350409	7.8542	\N	S	715	Carlsson, Mr. Carl Robert	24	Göteborg, Västergötland, Sweden	Southampton	Huntley, Illinois, US	\N	\N	3
1028	\N	3	Zakarian, Mr. Mapriededer	male	26.5	0	0	2656	7.225	\N	C	1313	Zakarian, Mr. Mapri Der	22	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	\N	304MB	3
1029	\N	2	Schmidt, Mr. August	male	26	0	0	248659	13	\N	S	560	Schmidt, Mr. August	26	Newark, New Jersey, US	Southampton	Newark, New Jersey, US	\N	\N	2
1030	\N	3	Drapkin, Miss. Jennie	female	23	0	0	SOTON/OQ 392083	8.05	\N	S	789	Dropkin, Miss Jennie	24	Mogilev, Belarus	Southampton	New York City	13	\N	3
1031	\N	3	Goodwin, Mr. Charles Frederick	male	40	1	6	CA 2144	46.9	\N	S	831	Goodwin, Mr. Frederick Joseph	42	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
1032	\N	3	Goodwin, Miss. Jessie Allis	female	10	5	2	CA 2144	46.9	\N	S	836	Goodwin, Miss Jessie Allis Mary	12	Fulham, England	Southampton	Niagara Falls, New York, US	\N	\N	3
1033	\N	1	Daniels, Miss. Sarah	female	33	0	0	113781	151.55	\N	S	6	and maid, Miss Sarah Daniels	33	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	8	\N	1
1034	\N	1	Ryerson, Mr. Arthur Larned	male	61	1	3	PC 17608	262.375	B57 B59 B63 B66	C	246	Ryerson, Mr. Arthur Larned	61	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	\N	\N	1
1035	\N	2	Beauchamp, Mr. Henry James	male	28	0	0	244358	26	\N	S	341	Beauchamp, Mr. Henry James	28	London, England, UK	Southampton	New York City	\N	194MB	2
1036	\N	1	Lindeberg-Lind, Mr. Erik Gustaf (Mr Edward Lingrey")"	male	42	0	0	17475	26.55	\N	S	186	Lindeberg-Lind, Mr. Erik Gustav (alias Edward Lingrey)	42	Jordanstorp, Södermanland, Sweden	Southampton	New York, New York, US	\N	\N	1
1037	\N	3	Vander Planke, Mr. Julius	male	31	3	0	345763	18	\N	S	1279	Vanderplancke, Mr. Julius	31	Zwevezele, Belgium	Southampton	Fremont, Ohio, US	\N	\N	3
1038	\N	1	Hilliard, Mr. Herbert Henry	male	\N	0	0	17463	51.8625	E46	S	158	Hilliard, Mr. Herbert Henry	44	Brighton, Massachusetts, US	Southampton	Brighton, Massachusetts, US	\N	\N	1
1039	\N	3	Davies, Mr. Evan	male	22	0	0	SC/A4 23568	8.05	\N	S	761	Davies, Mr. Evan	22	Pontardawe, West Glamorgan, Wales	Southampton	Pontiac, Michigan, US	\N	\N	3
1040	\N	1	Crafton, Mr. John Bertram	male	\N	0	0	113791	26.55	\N	S	85	Crafton, Mr. John Bertram	59	Roachdale, Indiana, US	Southampton	Roachdale, Indiana, US	\N	\N	1
1041	\N	2	Lahtinen, Rev. William	male	30	1	1	250651	26	\N	S	482	Lahtinen, Reverend William	35	Minneapolis, Minnesota, US	Southampton	Minneapolis, Minnesota, US	\N	\N	2
1042	\N	1	Earnshaw, Mrs. Boulton (Olive Potter)	female	23	0	1	11767	83.1583	C54	C	\N	\N	\N	\N	\N	\N	\N	\N	\N
1043	\N	3	Matinoff, Mr. Nicola	male	\N	0	0	349255	7.8958	\N	C	1005	Matinoff, Mr. Nicola	30	Gabrovo, Bulgaria	Cherbourg	Madison, Wisconsin, US	\N	\N	3
1044	\N	3	Storey, Mr. Thomas	male	60.5	0	0	3701	\N	\N	S	1233	Storey, Mr. Thomas	51	Liverpool, Merseyside, England,	Southampton	New York City	\N	261MB	3
1045	\N	3	Klasen, Mrs. (Hulda Kristina Eugenia Lofqvist)	female	36	0	2	350405	12.1833	\N	S	943	Klasén, Mrs. Hulda Kristina Eugenia (née Lofqvist)	36	Salmunds, Gotland, Sweden	Southampton	Los Angeles, US	\N	\N	3
1046	\N	3	Asplund, Master. Filip Oscar	male	13	4	2	347077	31.3875	\N	S	650	Asplund, Master Filip Oscar	13	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	\N	\N	3
1047	\N	3	Duquemin, Mr. Joseph	male	24	0	0	S.O./P.P. 752	7.55	\N	S	790	Duquemin, Mr. Joseph Pierre	19	Saint Sampson, Guernsey, Channel Islands, England	Southampton	Albion, New York, US	D	\N	3
1048	\N	1	Bird, Miss. Ellen	female	29	0	0	PC 17483	221.7792	C97	S	288	and maid, Miss Ellen Bird	31	New York, New York, US	Southampton	New York, New York, US	8	\N	1
1049	\N	3	Lundin, Miss. Olga Elida	female	23	0	0	347469	7.8542	\N	S	\N	\N	\N	\N	\N	\N	\N	\N	\N
1050	\N	1	Borebank, Mr. John James	male	42	0	0	110489	26.55	D22	S	37	Borebank, Mr. John James	42	London, England, UK	Southampton	Toronto, Ontario, Canada	\N	\N	1
1051	\N	3	Peacock, Mrs. Benjamin (Edith Nile)	female	26	0	2	SOTON/O.Q. 3101315	13.775	\N	S	1118	Peacock, Mrs. Edith (née Nile)	26	Southampton, Hampshire, England	Southampton	Elizabeth, New Jersey, US	\N	\N	3
1052	\N	3	Smyth, Miss. Julia	female	\N	0	0	335432	7.7333	\N	Q	1224	Smyth, Miss Julia	17	Kilcogy, Cavan, Ireland	Queenstown	New York City	13	\N	3
1053	\N	3	Touma, Master. Georges Youssef	male	7	1	1	2650	15.2458	\N	C	1265	Touma, Master Gerios (George) Youssef	8	Tibnin, Lebanon	Cherbourg	Dowagiac, Michigan, US	C	\N	3
1054	\N	2	Wright, Miss. Marion	female	26	0	0	220844	13.5	\N	S	606	Wright, Miss Marion	26	Yeovil, Somerset, England	Southampton	Cottage Grove, Oregon, US	9	\N	2
1055	\N	3	Pearce, Mr. Ernest	male	\N	0	0	343271	7	\N	S	1121	Pearce, Mr. Ernest	32	London, England	Southampton	New York City	\N	\N	3
1056	\N	2	Peruschitz, Rev. Joseph Maria	male	41	0	0	237393	13	\N	S	537	Peruschitz, Father Josef	28	Scheyern, Bavaria, German Empire[note 2]	Southampton	St. Cloud, Minnesota, US	\N	\N	2
1057	\N	3	Kink-Heilmann, Mrs. Anton (Luise Heilmann)	female	26	1	1	315153	22.025	\N	S	939	Kink, Mrs. Luise (née Heilmann)	26	Zürich, Switzerland	Southampton	Milwaukee, Wisconsin, US	2	\N	3
1058	\N	1	Brandeis, Mr. Emil	male	48	0	0	PC 17591	50.4958	B10	C	40	Brandeis, Mr. Emil	48	Omaha, Nebraska, US	Cherbourg	Omaha, Nebraska, US	\N	208MB	1
1059	\N	3	Ford, Mr. Edward Watson	male	18	2	2	W./C. 6608	34.375	\N	S	816	Ford, Mr. Edward Watson	18	Rotherfield, East Sussex, England	Southampton	Essex County, New Jersey, US	\N	\N	3
1060	\N	1	Cassebeer, Mrs. Henry Arthur Jr (Eleanor Genevieve Fosdick)	female	\N	0	0	17770	27.7208	\N	C	65	Cassebeer, Mrs. Eleanor Genevieve (née Fosdick)	36	New York, New York, US	Cherbourg	New York, New York, US	5	\N	1
1061	\N	3	Hellstrom, Miss. Hilda Maria	female	22	0	0	7548	8.9625	\N	S	867	Hellström, Miss Hilda Maria	22	Stora Tuna, Sweden	Southampton	Evanston, Illinois, US	C	\N	3
1062	\N	3	Lithman, Mr. Simon	male	\N	0	0	S.O./P.P. 251	7.55	\N	S	948	Kutscher, Mr. Simon	26	Edinburgh, Scotland	Southampton	New York City	\N	\N	3
1063	\N	3	Zakarian, Mr. Ortin	male	27	0	0	2670	7.225	\N	C	1312	Zakarian, Mr. Haroutyun Der	27	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	\N	\N	3
1064	\N	3	Dyker, Mr. Adolf Fredrik	male	23	1	0	347072	13.9	\N	S	792	Dyker, Mr. Adolf Fredrik	23	New Haven, Connecticut, US	Southampton	New Haven, Connecticut, US	\N	\N	3
1065	\N	3	Torfa, Mr. Assad	male	\N	0	0	2673	7.2292	\N	C	1261	Torfa, Mr. Assad	20	Unknown, Syria	Cherbourg	New York City	\N	\N	3
1066	\N	3	Asplund, Mr. Carl Oscar Vilhelm Gustafsson	male	40	1	5	347077	31.3875	\N	S	648	Asplund, Mr. Carl Oscar Vilhelm Gustafsson	40	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	\N	142MB	3
1067	\N	2	Brown, Miss. Edith Eileen	female	15	0	2	29750	39	\N	S	357	Brown, Miss Edith Eileen	15	Cape Town, South Africa, UK	Southampton	Seattle, Washington, US	14	\N	2
1068	\N	2	Sincock, Miss. Maude	female	20	0	0	C.A. 33112	36.75	\N	S	565	Sincock, Miss Maude	20	St. Ives, Cornwall, England	Southampton	Hancock, Michigan, US	11	\N	2
1069	\N	1	Stengel, Mr. Charles Emil Henry	male	54	1	0	11778	55.4417	C116	C	279	Stengel, Mr. Charles Emil Henry	54	Newark, New Jersey, US	Cherbourg	Newark, New Jersey, US	1	\N	1
1070	\N	2	Becker, Mrs. Allen Oliver (Nellie E Baumgardner)	female	36	0	3	230136	39	F4	S	342	Becker, Mrs. Nellie E. (née Baumgardner)	35	Guntur, Madras Province, British India[note 3]	Southampton	Benton Harbor, Michigan, US	11	\N	2
1071	\N	1	Compton, Mrs. Alexander Taylor (Mary Eliza Ingersoll)	female	64	0	2	PC 17756	83.1583	E45	C	81	Compton, Mrs. Mary Eliza (née Ingersoll)	64	Lakewood, New Jersey, US	Cherbourg	Lakewood, New Jersey, US	14	\N	1
1072	\N	2	McCrie, Mr. James Matthew	male	30	0	0	233478	13	\N	S	506	McCrie, Mr. James Matthew	32	Sarnia, Ontario, Canada	Southampton	Sarnia, Ontario, Canada	\N	\N	2
1073	\N	1	Compton, Mr. Alexander Taylor Jr	male	37	1	1	PC 17756	83.1583	E52	C	83	Compton, Mr. Alexander Taylor Jr.	37	Lakewood, New Jersey, US	Cherbourg	Lakewood, New Jersey, US	\N	\N	1
1074	\N	1	Marvin, Mrs. Daniel Warner (Mary Graham Carmichael Farquarson)	female	18	1	0	113773	53.1	D30	S	197	Marvin, Mrs. Mary Graham Carmichael (née Farquarson)[62][70]	18	New York, New York, US	Southampton	New York, New York, US	10	\N	1
1075	\N	3	Lane, Mr. Patrick	male	\N	0	0	7935	7.75	\N	Q	955	Lane, Mr. Patrick	16	Limerick, Limerick, Ireland	Queenstown	New York City	\N	\N	3
1076	\N	1	Douglas, Mrs. Frederick Charles (Mary Helene Baxter)	female	27	1	1	PC 17558	247.5208	B58 B60	C	103	Douglas, Mrs. Mary Hélène (née Baxter)	27	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	6	\N	1
1111	\N	3	Thomson, Mr. Alexander Morrison	male	\N	0	0	32302	8.05	\N	S	1253	Thompson, Mr. Alexander Morrison	36	Unknown, Scotland	Southampton	New York City	\N	\N	3
1077	\N	2	Maybery, Mr. Frank Hubert	male	40	0	0	239059	16	\N	S	504	Maybery, Mr. Frank Hubert	36	Weston-super-Mare, North Somerset, England	Southampton	Moose Jaw, Saskatchewan, Canada	\N	\N	2
1078	\N	2	Phillips, Miss. Alice Frances Louisa	female	21	0	1	S.O./P.P. 2	21	\N	S	539	Phillips, Miss Alice Frances Louisa	21	Ilfracombe, Devon, England	Southampton	New Brighton, Pennsylvania, US	12	\N	2
1079	\N	3	Davies, Mr. Joseph	male	17	2	0	A/4 48873	8.05	\N	S	764	Davies, Mr. Joseph	17	West Bromwich, Staffordshire, England	Southampton	Pontiac, Michigan, US	\N	\N	3
1080	\N	3	Sage, Miss. Ada	female	\N	8	2	CA. 2343	69.55	\N	S	1182	Sage, Miss Elizabeth Ada	10	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
1081	\N	2	Veal, Mr. James	male	40	0	0	28221	13	\N	S	582	Veal, Mr. James	40	Barre, Vermont, US	Southampton	Barre, Vermont, US	\N	\N	2
1082	\N	2	Angle, Mr. William A	male	34	1	0	226875	26	\N	S	331	Angle, Mr. William A.	32	Warwick, Warwickshire, England	Southampton	New York City	\N	\N	2
1083	\N	1	Salomon, Mr. Abraham L	male	\N	0	0	111163	26	\N	S	254	Salomon, Mr. Abraham Lincoln	43	New York, New York, US	Cherbourg	New York, New York, US	1	\N	1
1084	\N	3	van Billiard, Master. Walter John	male	11.5	1	1	A/5. 851	14.5	\N	S	1271	Van Billiard, Master Walter John	9	London, England	Southampton	North Wales, Pennsylvania, US	\N	1{?}MB[86][87]	3
1085	\N	2	Lingane, Mr. John	male	61	0	0	235509	12.35	\N	Q	494	Linnane, Mr. John	61	Chelsea, Michigan, US	Southampton	Chelsea, Michigan, US	\N	\N	2
1086	\N	2	Drew, Master. Marshall Brines	male	8	0	2	28220	32.5	\N	S	405	Drew, Master Marshall Brines	8	Greenport, New York, US	Southampton	Greenport, New York, US	10	\N	2
1087	\N	3	Karlsson, Mr. Julius Konrad Eugen	male	33	0	0	347465	7.8542	\N	S	921	Karlsson, Mr. Julius Konrad Eugen	33	Göteborg, Västergötland, Sweden	Southampton	New York City	\N	\N	3
1088	\N	1	Spedden, Master. Robert Douglas	male	6	0	2	16966	134.5	E34	C	272	Spedden, Master Robert Douglas	6	Tuxedo Park, New York, US	Cherbourg	Tuxedo Park, New York, US	3	\N	1
1089	\N	3	Nilsson, Miss. Berta Olivia	female	18	0	0	347066	7.775	\N	S	1069	Nilsson, Miss Berta Olivia	18	Lysvik, Värmland, Sweden	Southampton	Missoula, Montana, US	D	\N	3
1090	\N	2	Baimbrigge, Mr. Charles Robert	male	23	0	0	C.A. 31030	10.5	\N	S	335	Bainbrigge, Mr. Charles Robert	23	Saint Peter Port, Guernsey, Channel Islands	Southampton	New York City	\N	\N	2
1091	\N	3	Rasmussen, Mrs. (Lena Jacobsen Solvang)	female	\N	0	0	65305	8.1125	\N	S	1141	Rasmussen, Mrs. Lena Jakobsen (née Solvang)	62	Haugesund, Rogaland, Norway	Southampton	Centerville, South Dakota, US	\N	\N	3
1092	\N	3	Murphy, Miss. Nora	female	\N	0	0	36568	15.5	\N	Q	1052	Murphy, Miss Nora	34	Dublin, Ireland	Queenstown	New York City	16	\N	3
1093	\N	3	Danbom, Master. Gilbert Sigvard Emanuel	male	0.33	0	2	347080	14.4	\N	S	758	Danbom, Master Gilbert Sigvard Emanuel	0.33	Göteborg, Västergötland, Sweden	Southampton	Stanton, Iowa, US	\N	\N	3
1094	\N	1	Astor, Col. John Jacob	male	47	1	0	PC 17757	227.525	C62 C64	C	15	Astor, Colonel John Jacob IV	47	New York, New York, US	Cherbourg	New York, New York, US	\N	124MB	1
1095	\N	2	Quick, Miss. Winifred Vera	female	8	1	1	26360	26	\N	S	546	Quick, Miss Winnifred Vera	8	Plymouth, Devon, England	Southampton	Detroit, Michigan, US	11	\N	2
1096	\N	2	Andrew, Mr. Frank Thomas	male	25	0	0	C.A. 34050	10.5	\N	S	330	Andrew, Mr. Frank Thomas	30	Redruth, Cornwall, England	Southampton	Houghton, Michigan, US	\N	\N	2
1097	\N	1	Omont, Mr. Alfred Fernand	male	\N	0	0	F.C. 12998	25.7417	\N	C	219	Omont, Mr. Alfred Fernand	29	Le Havre, France	Cherbourg	New York, New York, US	7	\N	1
1098	\N	3	McGowan, Miss. Katherine	female	35	0	0	9232	7.75	\N	Q	1015	McGowan, Miss Catherine	42	Terry, Mayo, Ireland	Queenstown	Chicago, Illinois, US	\N	\N	3
1099	\N	2	Collett, Mr. Sidney C Stuart	male	24	0	0	28034	10.5	\N	S	382	Collett, Mr. Sidney Clarence Stuart	25	London, England	Southampton	Port Byron, New York, US	9	\N	2
1100	\N	1	Rosenbaum, Miss. Edith Louise	female	33	0	0	PC 17613	27.7208	A11	C	240	Rosenbaum, Miss Edith Louise	34	Paris, France	Cherbourg	Cincinnati, Ohio, US	11	\N	1
1101	\N	3	Delalic, Mr. Redjo	male	25	0	0	349250	7.8958	\N	S	774	Delalić, Mr. Redjo	25	Bakić, Bosnia	Southampton	Harrisburg, Pennsylvania, US	\N	\N	3
1102	\N	3	Andersen, Mr. Albert Karvin	male	32	0	0	C 4001	22.525	\N	S	630	Andersen, Mr. Albert Karvin	33	Bergen, Norway	Southampton	New York City	\N	260MB	3
1103	\N	3	Finoli, Mr. Luigi	male	\N	0	0	SOTON/O.Q. 3101308	7.05	\N	S	806	Finoli, Mr. Luigi	34	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	15	\N	3
1104	\N	2	Deacon, Mr. Percy William	male	17	0	0	S.O.C. 14879	73.5	\N	S	395	Deacon, Mr. Percy William	20	Fritham, Hampshire, England, UK	Southampton	Boston, Massachusetts, US	\N	\N	2
1105	\N	2	Howard, Mrs. Benjamin (Ellen Truelove Arman)	female	60	1	0	24065	26	\N	S	461	Howard, Mrs. Ellen Truelove (née Arman)	60	Swindon, Wiltshire, England	Southampton	Idaho, US	\N	\N	2
1106	\N	3	Andersson, Miss. Ida Augusta Margareta	female	38	4	2	347091	7.775	\N	S	640	Andersson, Miss Ida Augusta Margareta	38	Vadsbro, Sörmland, Sweden	Southampton	Manistee, Michigan, US	\N	\N	3
1107	\N	1	Head, Mr. Christopher	male	42	0	0	113038	42.5	B11	S	157	Head, Mr. Christopher	42	Chelsea, London, England, UK	Southampton	New York, New York, US	\N	\N	1
1108	\N	3	Mahon, Miss. Bridget Delia	female	\N	0	0	330924	7.8792	\N	Q	995	Mahon, Miss Bridget Delia	20	Derrymartin, Mayo, Ireland	Queenstown	New York City	\N	\N	3
1109	\N	1	Wick, Mr. George Dennick	male	57	1	1	36928	164.8667	\N	S	313	Wick, Colonel George Dennick	58	Youngstown, Ohio, US	Southampton	Youngstown, Ohio, US	\N	\N	1
1110	\N	1	Widener, Mrs. George Dunton (Eleanor Elkins)	female	50	1	1	113503	211.5	C80	C	318	Widener, Mrs. Eleanor (née Elkins)	50	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	4	\N	1
1112	\N	2	Duran y More, Miss. Florentina	female	30	1	0	SC/PARIS 2148	13.8583	\N	C	406	Duran y More, Miss Florentina	30	Barcelona, Catalonia, Spain	Cherbourg	Havana, Cuba	12	\N	2
1113	\N	3	Reynolds, Mr. Harold J	male	21	0	0	342684	8.05	\N	S	1145	Reynolds, Mr. Harold J.	21	London, England	Southampton	Toronto, Ontario, Canada	\N	327MM	3
1114	\N	2	Cook, Mrs. (Selena Rogers)	female	22	0	0	W./C. 14266	10.5	F33	S	386	Cook, Mrs. Selena (née Rogers)	22	Oxford, Oxfordshire, England	Southampton	New York City	14	\N	2
1115	\N	3	Karlsson, Mr. Einar Gervasius	male	21	0	0	350053	7.7958	\N	S	920	Karlsson, Mr. Einar Gervasius	21	Oskarshamn, Kalmar, Sweden	Southampton	Brooklyn, New York, US	13	\N	3
1116	\N	1	Candee, Mrs. Edward (Helen Churchill Hungerford)	female	53	0	0	PC 17606	27.4458	\N	C	49	Candee, Mrs. Helen Churchill (née Hungerford)	53	Washington, DC, US	Cherbourg	Washington, DC, US	6	\N	1
1117	\N	3	Moubarek, Mrs. George (Omine Amenia" Alexander)"	female	\N	0	2	2661	15.2458	\N	C	1044	Mubarik, Mrs. Amanah Fa'ud (née Iskandar)	24	Hardîne, Lebanon	Cherbourg	Houtzdale, Pennsylvania, US	C	\N	3
1118	\N	3	Asplund, Mr. Johan Charles	male	23	0	0	350054	7.7958	\N	S	655	Asplund, Mr. Johan Charles	23	Oskarshamn, Kalmar, Sweden	Southampton	Minneapolis, Minnesota, US	13	\N	3
1119	\N	3	McNeill, Miss. Bridget	female	\N	0	0	370368	7.75	\N	Q	1019	McNeill, Miss Bridget	27	Trien, Roscommon, Ireland	Queenstown	New York City	\N	\N	3
1120	\N	3	Everett, Mr. Thomas James	male	40.5	0	0	C.A. 6212	15.1	\N	S	803	Everett, Mr. Thomas James	39	Bristol, Avon, England	Southampton	Troy, New York, US	\N	187MB	3
1121	\N	2	Hocking, Mr. Samuel James Metcalfe	male	36	0	0	242963	13	\N	S	454	Hocking, Mr. Samuel James Metcalfe	36	Devonport, Devon, England	Southampton	Middletown, Connecticut, US	\N	\N	2
1122	\N	2	Sweet, Mr. George Frederick	male	14	0	0	220845	65	\N	S	574	Sweet, Mr. George Frederick	14	Yeovil, Somerset, England	Southampton	Bernardsville, New Jersey, US	\N	\N	2
1123	\N	1	Willard, Miss. Constance	female	21	0	0	113795	26.55	\N	S	321	Willard, Miss Constance	21	Duluth, Minnesota, US	Southampton	Duluth, Minnesota, US	8	\N	1
1124	\N	3	Wiklund, Mr. Karl Johan	male	21	1	0	3101266	6.4958	\N	S	1296	Wiklund, Mr. Karl Johan	21	Vaasa, Finland	Southampton	Montreal, Quebec, Canada	\N	\N	3
1125	\N	3	Linehan, Mr. Michael	male	\N	0	0	330971	7.8792	\N	Q	978	Linehan, Mr. Michael	21	Boherbue, Cork, Ireland	Queenstown	New York City	\N	\N	3
1126	\N	1	Cumings, Mr. John Bradley	male	39	1	0	PC 17599	71.2833	C85	C	89	Cumings, Mr. John Bradley	39	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
1127	\N	3	Vendel, Mr. Olof Edvin	male	20	0	0	350416	7.8542	\N	S	1285	Vendel, Mr. Olof Edvin	29	Östra Sallerup, Skåne, Sweden	Southampton	St. Paul, Minnesota, US	\N	\N	3
1128	\N	1	Warren, Mr. Frank Manley	male	64	1	0	110813	75.25	D37	C	305	Warren, Mr. Frank Manley	63	Portland, Oregon, US	Cherbourg	Portland, Oregon, US	\N	\N	1
1129	\N	3	Baccos, Mr. Raffull	male	20	0	0	2679	7.225	\N	C	662	Bakus, Mr. Raful	20	Unknown, Lebanon	Cherbourg	New York City	\N	\N	3
1130	\N	2	Hiltunen, Miss. Marta	female	18	1	1	250650	13	\N	S	450	Hiltunen, Miss Martta	18	Joensuu, Finland, Russian Empire[note 6]	Southampton	Detroit, Michigan, US	\N	\N	2
1131	\N	1	Douglas, Mrs. Walter Donald (Mahala Dutton)	female	48	1	0	PC 17761	106.425	C86	C	101	Douglas, Mrs. Mahala (née Dutton)	48	Minneapolis, Minnesota, US	Cherbourg	Minneapolis, Minnesota, US	2	\N	1
1132	\N	1	Lindstrom, Mrs. Carl Johan (Sigrid Posse)	female	55	0	0	112377	27.7208	\N	C	187	Lindström, Mrs. Sigrid (née Posse)	55	Stockholm, Sweden	Cherbourg	New York, New York, US	6	\N	1
1133	\N	2	Christy, Mrs. (Alice Frances)	female	45	0	2	237789	30	\N	S	375	Christy, Mrs. Alice Frances	45	London, England, UK	Southampton	Montreal, Quebec, Canada	12	\N	2
1134	\N	1	Spedden, Mr. Frederic Oakley	male	45	1	1	16966	134.5	E34	C	269	Spedden, Mr. Frederic Oakley	45	Tuxedo Park, New York, US	Cherbourg	Tuxedo Park, New York, US	3	\N	1
1135	\N	3	Hyman, Mr. Abraham	male	\N	0	0	3470	7.8875	\N	S	880	Hyman, Mr. Solomon Abraham	34	Manchester, England	Southampton	Springfield, Massachusetts, US	C	\N	3
1136	\N	3	Johnston, Master. William Arthur Willie""	male	\N	1	2	W./C. 6607	23.45	\N	S	909	Johnston, Master William Andrew	8	Thornton Heath, London, England	Southampton	New London, Connecticut, US	\N	\N	3
1137	\N	1	Kenyon, Mr. Frederick R	male	41	1	0	17464	51.8625	D21	S	176	Kenyon, Mr. Frederick R.	41	Pittsburgh, Pennsylvania, US	Southampton	Pittsburgh, Pennsylvania, US	\N	\N	1
1138	\N	2	Karnes, Mrs. J Frank (Claire Bennett)	female	22	0	0	F.C.C. 13534	21	\N	S	474	Karnes, Mrs. Claire (née Bennett)	28	Pittsburgh, Pennsylvania, US	Southampton	Pittsburgh, Pennsylvania, US	\N	\N	2
1139	\N	2	Drew, Mr. James Vivian	male	42	1	1	28220	32.5	\N	S	403	Drew, Mr. James Vivian	42	Greenport, New York, US	Southampton	Greenport, New York, US	\N	\N	2
1140	\N	2	Hold, Mrs. Stephen (Annie Margaret Hill)	female	29	1	0	26707	26	\N	S	457	Hold, Mrs. Annie Margaret (née Hill)	29	Porthoustock, Cornwall, England	Southampton	Sacramento, California, US	10	\N	2
1141	\N	3	Khalil, Mrs. Betros (Zahie Maria" Elias)"	female	\N	1	0	2660	14.4542	\N	C	934	Khalil-Khoury, Mrs. Zahie "Maria"	20	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	\N	\N	3
1142	\N	2	West, Miss. Barbara J	female	0.92	1	2	C.A. 34651	27.75	\N	S	599	West, Miss Barbara Joyce	0.83	Bournemouth, Dorset, England	Southampton	Gainesville, Florida, US	10	\N	2
1143	\N	3	Abrahamsson, Mr. Abraham August Johannes	male	20	0	0	SOTON/O2 3101284	7.925	\N	S	615	Abrahamsson, Mr. Abraham August Johannes	20	Dalsbruk, Finland	Southampton	Hoboken, New Jersey, US	15	\N	3
1144	\N	1	Clark, Mr. Walter Miller	male	27	1	0	13508	136.7792	C89	C	77	Clark, Mr. Walter Miller	27	Los Angeles, California, US	Cherbourg	Los Angeles, California, US	\N	\N	1
1214	\N	2	Nesson, Mr. Israel	male	26	0	0	244368	13	F2	S	524	Nesson, Mr. Israel	26	London, England	Southampton	Boston, Massachusetts, US	\N	\N	2
1145	\N	3	Salander, Mr. Karl Johan	male	24	0	0	7266	9.325	\N	S	1185	Salander, Mr. Karl Johan	24	Genevad, Halland, Sweden	Southampton	Red Wing, Minnesota, US	\N	\N	3
1146	\N	3	Wenzel, Mr. Linhart	male	32.5	0	0	345775	9.5	\N	S	980	Linhart, Mr. Wenzel H.	27	Vienna, Austria	Southampton	New York City	\N	298MB	3
1147	\N	3	MacKay, Mr. George William	male	\N	0	0	C.A. 42795	7.55	\N	S	991	Mackay, Mr. George William	20	London, England	Southampton	Rochester, New York, US	\N	\N	3
1148	\N	3	Mahon, Mr. John	male	\N	0	0	AQ/4 3130	7.75	\N	Q	1021	Meehan, Mr. John	22	Currowhunane, Sligo, Ireland	Queenstown	Patterson, New Jersey, US	\N	\N	3
1149	\N	3	Niklasson, Mr. Samuel	male	28	0	0	363611	8.05	\N	S	1067	Niklasson, Mr. Samuel	28	Västra Bogane, Orust Island, Sweden	Southampton	New York City	\N	\N	3
1150	\N	2	Bentham, Miss. Lilian W	female	19	0	0	28404	13	\N	S	347	Bentham, Miss Lillian W.	19	Rochester, New York, US	Southampton	Rochester, New York, US	12	\N	2
1151	\N	3	Midtsjo, Mr. Karl Albert	male	21	0	0	345501	7.775	\N	S	1026	Midtsjø, Mr. Karl Albert	21	Krøkstad, Ski, Norway	Southampton	Chicago, Illinois, US	15	\N	3
1152	\N	3	de Messemaeker, Mr. Guillaume Joseph	male	36.5	1	0	345572	17.4	\N	S	766	De Messemaeker, Mr. Guillaume Joseph	36	Tampico, Montana, US	Southampton	Tampico, Montana, US	15	\N	3
1153	\N	3	Nilsson, Mr. August Ferdinand	male	21	0	0	350410	7.8542	\N	S	1068	Nilsson, Mr. August Ferdinand	21	Hörby, Skåne, Sweden	Southampton	St. Paul, Minnesota, US	\N	\N	3
1154	\N	2	Wells, Mrs. Arthur Henry (Addie" Dart Trevaskis)"	female	29	0	2	29103	23	\N	S	593	Wells, Mrs. Addie Dart (née Trevaskis)	29	Heamoor, Cornwall, England	Southampton	Akron, Ohio, US	14	\N	2
1155	\N	3	Klasen, Miss. Gertrud Emilia	female	1	1	1	350405	12.1833	\N	S	945	Klasén, Miss Gertrud Emilia	1	Grimshut, Småland, Sweden	Southampton	New York City	\N	\N	3
1156	\N	2	Portaluppi, Mr. Emilio Ilario Giuseppe	male	30	0	0	C.A. 34644	12.7375	\N	C	543	Portaluppi, Mr. Emilio Ilario Giuseppe	34	Milford, New Hampshire, US	Southampton	Milford, New Hampshire, US	14	\N	2
1157	\N	3	Lyntakoff, Mr. Stanko	male	\N	0	0	349235	7.8958	\N	S	990	Lyntakoff, Mr. Stanko	44	Unknown, Bulgaria	Southampton	Coon Rapids, Iowa, US	\N	\N	3
1158	\N	1	Chisholm, Mr. Roderick Robert Crispin	male	\N	0	0	112051	0	\N	S	76	Chisholm, Mr. Roderick Robert Crispin[60]	40	Belfast, Ireland, UK	Belfast	New York, New York, US	\N	\N	1
1159	\N	3	Warren, Mr. Charles William	male	\N	0	0	C.A. 49867	7.55	\N	S	1290	Warren, Mr. Charles William	30	Portsmouth, Hampshire, England	Southampton	New York City	\N	\N	3
1160	\N	3	Howard, Miss. May Elizabeth	female	\N	0	0	A. 2. 39186	8.05	\N	S	877	Howard, Miss May Elizabeth	27	North Walsham, Norfolk, England	Southampton	Albion, Michigan, US	C	\N	3
1161	\N	3	Pokrnic, Mr. Mate	male	17	0	0	315095	8.6625	\N	S	1137	Pocrnić, Mr. Mate	17	Bukovac, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
1162	\N	1	McCaffry, Mr. Thomas Francis	male	46	0	0	13050	75.2417	C6	C	199	McCaffry, Mr. Thomas Francis	46	Vancouver, British Columbia, Canada	Southampton	Vancouver, British Columbia, Canada	\N	292MB	1
1163	\N	3	Fox, Mr. Patrick	male	\N	0	0	368573	7.75	\N	Q	819	Fox, Mr. Patrick	28	Mullingar, Westmeath, Ireland	Queenstown	New York City	\N	\N	3
1164	\N	1	Clark, Mrs. Walter Miller (Virginia McDowell)	female	26	1	0	13508	136.7792	C89	C	78	Clark, Mrs. Virginia Estelle (née McDowell)	26	Los Angeles, California, US	Cherbourg	Los Angeles, California, US	4	\N	1
1165	\N	3	Lennon, Miss. Mary	female	\N	1	0	370371	15.5	\N	Q	969	Lennon, Miss Mary	18	Ballymahon, Longford, Ireland	Queenstown	New York City	\N	\N	3
1166	\N	3	Saade, Mr. Jean Nassr	male	\N	0	0	2676	7.225	\N	C	1063	Nassr Rizq, Mr. Saade	20	Sir'Al, Lebanon	Cherbourg	New York City	\N	\N	3
1167	\N	2	Bryhl, Miss. Dagmar Jenny Ingeborg 	female	20	1	0	236853	26	\N	S	359	Bryhl, Miss Dagmar Jenny Ingeborg	20	Skara, Västergötland, Sweden	Southampton	Rockford, Illinois, US	12	\N	2
1168	\N	2	Parker, Mr. Clifford Richard	male	28	0	0	SC 14888	10.5	\N	S	533	Parker, Mr. Clifford Richard	28	Guernsey, Channel Islands	Southampton	New York City	\N	\N	2
1169	\N	2	Faunthorpe, Mr. Harry	male	40	1	0	2926	26	\N	S	411	Faunthorpe, Mr. Harry Bartram	40	Liverpool, Merseyside, England, UK	Southampton	Philadelphia, Pennsylvania, US	\N	286MB	2
1170	\N	2	Ware, Mr. John James	male	30	1	0	CA 31352	21	\N	S	584	Ware, Mr. John James	45	Bristol, Avon, England	Southampton	New Britain, Connecticut, US	\N	\N	2
1171	\N	2	Oxenham, Mr. Percy Thomas	male	22	0	0	W./C. 14260	10.5	\N	S	529	Oxenham, Mr. Percy Thomas	22	London, England	Southampton	North Bergen, New Jersey, US	13	\N	2
1172	\N	3	Oreskovic, Miss. Jelka	female	23	0	0	315085	8.6625	\N	S	1100	Orešković, Miss Jelka	23	Konjsko Brdo, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
1173	\N	3	Peacock, Master. Alfred Edward	male	0.75	1	1	SOTON/O.Q. 3101315	13.775	\N	S	1120	Peacock, Master Albert Edward	0.58	Southampton, Hampshire, England	Southampton	Elizabeth, New Jersey, US	\N	\N	3
1174	\N	3	Fleming, Miss. Honora	female	\N	0	0	364859	7.75	\N	Q	808	Fleming, Miss Honora "Nora"	22	Carrowskehine, Mayo, Ireland	Queenstown	New York City	\N	\N	3
1175	\N	3	Touma, Miss. Maria Youssef	female	9	1	1	2650	15.2458	\N	C	1264	Touma, Miss Marianna Youssef	9	Tibnin, Lebanon	Cherbourg	Dowagiac, Michigan, US	C	\N	3
1176	\N	3	Rosblom, Miss. Salli Helena	female	2	1	1	370129	20.2125	\N	S	1163	Rosblom, Miss Salli Helena	2	Suistamo, Finland	Southampton	Astoria, Oregon, US	\N	\N	3
1177	\N	3	Dennis, Mr. William	male	36	0	0	A/5 21175	7.25	\N	S	776	Dennis, Mr. William	26	Week St Mary, Cornwall, England	Southampton	Saskatoon, Saskatchewan, Canada	\N	\N	3
1178	\N	3	Franklin, Mr. Charles (Charles Fardon)	male	\N	0	0	SOTON/O.Q. 3101314	7.25	\N	S	804	Fardon, Mr. Charles R.(alias Charles Franklin)	38	Wellingborough, Northamptonshire, England	Cherbourg	Canada	\N	\N	3
1179	\N	1	Snyder, Mr. John Pillsbury	male	24	1	0	21228	82.2667	B45	S	267	Snyder, Mr. John Pillsbury	24	Minneapolis, Minnesota, US	Southampton	Minneapolis, Minnesota, US	7	\N	1
1180	\N	3	Mardirosian, Mr. Sarkis	male	\N	0	0	2655	7.2292	F E46	C	1001	Mardirosian, Mr. Sarkis	25	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	\N	\N	3
1181	\N	3	Ford, Mr. Arthur	male	\N	0	0	A/5 1478	8.05	\N	S	813	Ford, Mr. Arthur	22	Bridgwater, Somerset, England	Southampton	Elmira, New York, US	\N	\N	3
1182	\N	1	Rheims, Mr. George Alexander Lucien	male	\N	0	0	PC 17607	39.6	\N	S	234	Rheims, Mr. George Alexander Lucien	36	Paris, France	Southampton	New York, New York, US	A	\N	1
1183	\N	3	Daly, Miss. Margaret Marcella Maggie""	female	30	0	0	382650	6.95	\N	Q	754	Daly, Miss Margaret "Maggie"	30	Athlone, Westmeath, Ireland	Queenstown	New York City	15	\N	3
1184	\N	3	Nasr, Mr. Mustafa	male	\N	0	0	2652	7.2292	\N	C	1062	Nasr Alma, Mr. Mustafa	20	Tebnine, Lebanon	Cherbourg	New York City	\N	\N	3
1185	\N	1	Dodge, Dr. Washington	male	53	1	1	33638	81.8583	A34	S	97	Dodge, Dr. Washington	52	San Francisco, California, US	Southampton	San Francisco, California, US	13	\N	1
1186	\N	3	Wittevrongel, Mr. Camille	male	36	0	0	345771	9.5	\N	S	1305	Wittevrongel, Mr. Camilius Aloysius	36	Westrozebeke, Belgium	Southampton	Detroit, Michigan, US	\N	\N	3
1187	\N	3	Angheloff, Mr. Minko	male	26	0	0	349202	7.8958	\N	S	643	Angheloff, Mr. Minko	26	Terziysko, Troyan, Bulgaria	Southampton	Chicago, Illinois, US	\N	\N	3
1188	\N	2	Laroche, Miss. Louise	female	1	1	2	SC/Paris 2123	41.5792	\N	C	488	Laroche, Miss Louise Marguerite	1	Paris, France	Cherbourg	Cap-Haïtien, Haiti	14	\N	2
1189	\N	3	Samaan, Mr. Hanna	male	\N	2	0	2662	21.6792	\N	C	1189	Sa'maan, Mr. Hanna Ilyas	40	Hardîne, Lebanon	Cherbourg	Wilkes-Barre, Pennsylvania, US	\N	\N	3
1190	\N	1	Loring, Mr. Joseph Holland	male	30	0	0	113801	45.5	\N	S	192	Loring, Mr. Joseph Holland	30	London, England, UK	Southampton	New York, New York, US	\N	\N	1
1191	\N	3	Johansson, Mr. Nils	male	29	0	0	347467	7.8542	\N	S	899	Johansson, Mr. Nils	29	Chicago, Illinois, US	Southampton	Chicago, Illinois, US	\N	\N	3
1192	\N	3	Olsson, Mr. Oscar Wilhelm	male	32	0	0	347079	7.775	\N	S	1098	Olsson, Mr. Oskar Wilhelm	32	Lunna, Orust Island, Sweden	Southampton	Manitowoc, Wisconsin, US	A	\N	3
1193	\N	2	Malachard, Mr. Noel	male	\N	0	0	237735	15.0458	D	C	498	Malachard, Mr. Jean-Noël	25	Paris, France	Cherbourg	New York City	\N	\N	2
1194	\N	2	Phillips, Mr. Escott Robert	male	43	0	1	S.O./P.P. 2	21	\N	S	538	Phillips, Mr. Escott Robert	42	Ilfracombe, Devon, England	Southampton	New Brighton, Pennsylvania, US	\N	\N	2
1195	\N	3	Pokrnic, Mr. Tome	male	24	0	0	315092	8.6625	\N	S	1138	Pocrnić, Mr. Tome	24	Bukovac, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
1196	\N	3	McCarthy, Miss. Catherine Katie""	female	\N	0	0	383123	7.75	\N	Q	1006	McCarthy, Miss Catherine "Katie"	24	Tipperary, Ireland	Queenstown	Bayonne, New Jersey, US	?	\N	3
1197	\N	1	Crosby, Mrs. Edward Gifford (Catherine Elizabeth Halstead)	female	64	1	1	112901	26.55	B26	S	87	Crosby, Mrs. Catherine Elizabeth (née Halstead)	64	Milwaukee, Wisconsin, US	Southampton	Milwaukee, Wisconsin, US	7	\N	1
1198	\N	1	Allison, Mr. Hudson Joshua Creighton	male	30	1	2	113781	151.55	C22 C26	S	2	Allison, Mr. Hudson Joshua Creighton	30	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	135MB	1
1199	\N	3	Aks, Master. Philip Frank	male	0.83	0	1	392091	9.35	\N	S	621	Aks, Master Frank Philip	0.83	London, England	Southampton	Norfolk, Virginia, US	11	\N	3
1200	\N	1	Hays, Mr. Charles Melville	male	55	1	1	12749	93.5	B69	S	152	Hays, Mr. Charles Melville	55	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	307M	1
1201	\N	3	Hansen, Mrs. Claus Peter (Jennie L Howard)	female	45	1	0	350026	14.1083	\N	S	856	Hansen, Mrs. Jennie Louise (née Howard)	45	Racine, Wisconsin, US	Southampton	Racine, Wisconsin, US	11	\N	3
1202	\N	3	Cacic, Mr. Jego Grga	male	18	0	0	315091	8.6625	\N	S	704	Čačić, Mr. Jego Grga	18	Široka Kula, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
1203	\N	3	Vartanian, Mr. David	male	22	0	0	2658	7.225	\N	C	1284	Vartanian, Mr. Dawud	22	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	13	\N	3
1204	\N	3	Sadowitz, Mr. Harry	male	\N	0	0	LP 1588	7.575	\N	S	1173	Sadowitz, Mr. Harry	17	London, England	Southampton	Providence, Rhode Island, US	\N	\N	3
1205	\N	3	Carr, Miss. Jeannie	female	37	0	0	368364	7.75	\N	Q	717	Carr, Miss Jane	47	Aclare, Sligo, Ireland	Queenstown	Hartford, Connecticut, US	\N	\N	3
1206	\N	1	White, Mrs. John Stuart (Ella Holmes)	female	55	0	0	PC 17760	135.6333	C32	C	310	White, Mrs. Ella (née Holmes)	55	New York, New York, US	Cherbourg	New York, New York, US	8	\N	1
1207	\N	3	Hagardon, Miss. Kate	female	17	0	0	AQ/3. 30631	7.7333	\N	Q	859	Hargadon, Miss Catherine "Kate"	17	Ballysadare, Sligo, Ireland	Queenstown	New York City	\N	\N	3
1208	\N	1	Spencer, Mr. William Augustus	male	57	1	0	PC 17569	146.5208	B78	C	274	Spencer, Mr. William Augustus	57	New York, New York, US	Cherbourg	New York, New York, US	\N	\N	1
1209	\N	2	Rogers, Mr. Reginald Harry	male	19	0	0	28004	10.5	\N	S	558	Rogers, Mr. Reginald Harry	18	Tavistock, Devon, England	Southampton	Wilkes Barre, Pennsylvania, US	\N	\N	2
1210	\N	3	Jonsson, Mr. Nils Hilding	male	27	0	0	350408	7.8542	\N	S	913	Jönsson, Mr. Nils Hilding	27	Tågarp, Skåne, Sweden	Southampton	New York City	\N	\N	3
1211	\N	2	Jefferys, Mr. Ernest Wilfred	male	22	2	0	C.A. 31029	31.5	\N	S	469	Jefferys, Mr. Ernest Wilifred	22	Guernsey, Channel Islands	Southampton	Elizabeth, New Jersey, US	\N	\N	2
1212	\N	3	Andersson, Mr. Johan Samuel	male	26	0	0	347075	7.775	\N	S	641	Andersson, Mr. Johan Samuel	26	Hartford, Connecticut, US	Southampton	Hartford, Connecticut, US	\N	\N	3
1213	\N	3	Krekorian, Mr. Neshan	male	25	0	0	2654	7.2292	F E57	C	947	Krekorian, Mr. Neshan	25	Kiğı, Turkey	Cherbourg	Brantford, Ontario, Canada	10	\N	3
1215	\N	1	Rowe, Mr. Alfred G	male	33	0	0	113790	26.55	\N	S	245	Rowe, Mr. Alfred G.	59	Liverpool, Merseyside, England, UK	Southampton	New York, New York, US	\N	109MB	1
1216	\N	1	Kreuchen, Miss. Emilie	female	39	0	0	24160	211.3375	\N	S	236	and maid, Miss Emilie Kreuchen	29	St Louis, Missouri, US	Southampton	St Louis, Missouri, US	2	\N	1
1217	\N	3	Assam, Mr. Ali	male	23	0	0	SOTON/O.Q. 3101309	7.05	\N	S	657	Assam, Mr. Ali	23	Buenos Aires, Argentina	Southampton	New York City	\N	\N	3
1218	\N	2	Becker, Miss. Ruth Elizabeth	female	12	2	1	230136	39	F4	S	343	Becker, Miss Ruth Elizabeth	12	Guntur, Madras Province, British India	Southampton	Benton Harbor, Michigan, US	13	\N	2
1219	\N	1	Rosenshine, Mr. George (Mr George Thorne")"	male	46	0	0	PC 17585	79.2	\N	C	241	Rosenshine, Mr. George (alias George Thorne)	46	New York, New York, US	Cherbourg	New York, New York, US	\N	16MB	1
1220	\N	2	Clarke, Mr. Charles Valentine	male	29	1	0	2003	26	\N	S	377	Clarke, Mr. Charles Valentine	29	Netley Abbey, Hampshire, England	Southampton	San Francisco, California, US	\N	\N	2
1221	\N	2	Enander, Mr. Ingvar	male	21	0	0	236854	13	\N	S	409	Enander, Mr. Ingvar	21	Göteborg, Västergötland, Sweden	Southampton	Rockford, Illinois, US	\N	\N	2
1222	\N	2	Davies, Mrs. John Morgan (Elizabeth Agnes Mary White) 	female	48	0	2	C.A. 33112	36.75	\N	S	392	Davies, Mrs. Elizabeth Agnes Mary (née White)	48	St. Ives, Cornwall, England	Southampton	Houghton, Michigan, US	14	\N	2
1223	\N	1	Dulles, Mr. William Crothers	male	39	0	0	PC 17580	29.7	A18	C	107	Dulles, Mr. William Crothers	39	Philadelphia, Pennsylvania, US	Cherbourg	Philadelphia, Pennsylvania, US	\N	133MB	1
1224	\N	3	Thomas, Mr. Tannous	male	\N	0	0	2684	7.225	\N	C	1252	Thomas, Mr. Tannous John	16	Unknown, Lebanon	Cherbourg	Columbus, Ohio, US	\N	\N	3
1225	\N	3	Nakid, Mrs. Said (Waika Mary" Mowad)"	female	19	1	1	2653	15.7417	\N	C	1056	Nackid, Miss Waika "Mary" (née Mowad)	19	Zgharta, Lebanon	Cherbourg	Waterbury, Connecticut, US	C	\N	3
1226	\N	3	Cor, Mr. Ivan	male	27	0	0	349229	7.8958	\N	S	738	Čor, Mr. Ivan	27	Kricina, Croatia	Southampton	Great Falls, Montana, US	\N	\N	3
1227	\N	1	Maguire, Mr. John Edward	male	30	0	0	110469	26	C106	S	194	Maguire, Mr. John Edward	30	Brockton, Massachusetts, US	Southampton	Brockton, Massachusetts, US	\N	\N	1
1228	\N	2	de Brito, Mr. Jose Joaquim	male	32	0	0	244360	13	\N	S	354	Brito, Mr. José Joaquim	32	Madeira, Portugal	Southampton	São Paulo, Brazil	\N	\N	2
1229	\N	3	Elias, Mr. Joseph	male	39	0	2	2675	7.2292	\N	C	\N	\N	\N	\N	\N	\N	\N	\N	\N
1230	\N	2	Denbury, Mr. Herbert	male	25	0	0	C.A. 31029	31.5	\N	S	398	Denbuoy, Mr. Albert "Herbert"	25	Guernsey, Channel Islands, UK	Southampton	Elizabeth, New Jersey, US	\N	\N	2
1231	\N	3	Betros, Master. Seman	male	\N	0	0	2622	7.2292	\N	C	1188	Sa'maan, Master Butrus	10	Hardîne, Lebanon	Cherbourg	Wilkes Barre, Pennsylvania, US	\N	\N	3
1232	\N	2	Fillbrook, Mr. Joseph Charles	male	18	0	0	C.A. 15185	10.5	\N	S	412	Fillbrook, Mr. Joseph Charles	18	Truro, Cornwall, England, UK	Southampton	Houghton, Michigan, US	\N	\N	2
1233	\N	3	Lundstrom, Mr. Thure Edvin	male	32	0	0	350403	7.5792	\N	S	988	Lundström, Mr. Thure Edvin	32	Simrishamn, Skåne, Sweden	Southampton	Los Angeles, US	15	\N	3
1234	\N	3	Sage, Mr. John George	male	\N	1	9	CA. 2343	69.55	\N	S	1174	Sage, Mr. John George	44	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
1235	\N	1	Cardeza, Mrs. James Warburton Martinez (Charlotte Wardle Drake)	female	58	0	1	PC 17755	512.3292	B51 B53 B55	C	50	Cardeza, Mrs. Charlotte Wardle (née Drake)	58	Germantown, Pennsylvania, US	Cherbourg	Germantown, Pennsylvania, US	3	\N	1
1236	\N	3	van Billiard, Master. James William	male	\N	1	1	A/5. 851	14.5	\N	S	1270	Van Billiard, Master James William	10	London, England	Southampton	North Wales, Pennsylvania, US	\N	\N	3
1237	\N	3	Abelseth, Miss. Karen Marie	female	16	0	0	348125	7.65	\N	S	613	Abelseth, Miss Karen Marie	16	Sondmore, Norway	Southampton	Los Angeles, California, US	16	\N	3
1238	\N	2	Botsford, Mr. William Hull	male	26	0	0	237670	13	\N	S	349	Botsford, Mr. William Hull	25	Orange, New Jersey, US	Southampton	Orange, New Jersey, US	\N	\N	2
1239	\N	3	Whabee, Mrs. George Joseph (Shawneene Abi-Saab)	female	38	0	0	2688	7.2292	\N	C	893	Jirjis, Mrs. Shaniini (née Whabee Abi-Saab)	22	Youngstown, Ohio, US	Cherbourg	Youngstown, Ohio, US	C	\N	3
1240	\N	2	Giles, Mr. Ralph	male	24	0	0	248726	13.5	\N	S	425	Giles, Mr. Ralph	25	London, England	Southampton	New York City	\N	297MB	2
1241	\N	2	Walcroft, Miss. Nellie	female	31	0	0	F.C.C. 13528	21	\N	S	583	Wallcroft, Miss Ellen "Nellie"	36	Maidenhead, Berkshire, England	Southampton	Mamaroneck, New York, US	14	\N	2
1242	\N	1	Greenfield, Mrs. Leo David (Blanche Strouse)	female	45	0	1	PC 17759	63.3583	D10 D12	C	139	Greenfield, Mrs. Blanche (née Strouse)	45	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
1243	\N	2	Stokes, Mr. Philip Joseph	male	25	0	0	F.C.C. 13540	10.5	\N	S	573	Stokes, Mr. Philip Joseph	25	London, England	Southampton	Detroit, Michigan, US	\N	81MB	2
1244	\N	2	Dibden, Mr. William	male	18	0	0	S.O.C. 14879	73.5	\N	S	399	Dibden, Mr. William	18	Lyndhurst, Hampshire, England	Southampton	Eden, Manitoba, Canada	\N	\N	2
1245	\N	2	Herman, Mr. Samuel	male	49	1	2	220845	65	\N	S	442	Herman, Mr. Samuel	49	Yeovil, Somerset, England	Southampton	Bernardsville, New Jersey, US	\N	\N	2
1246	\N	3	Dean, Miss. Elizabeth Gladys Millvina""	female	0.17	1	2	C.A. 2315	20.575	\N	S	773	Dean, Miss Elizabeth Gladys "Millvina"	0.17	Bartley Farm, Hampshire, England	Southampton	Wichita, Kansas, US	10	\N	3
1247	\N	1	Julian, Mr. Henry Forbes	male	50	0	0	113044	26	E60	S	174	Julian, Mr. Henry Forbes	50	Torquay, Devon, England, UK	Southampton	San Francisco, US	\N	\N	1
1248	\N	1	Brown, Mrs. John Murray (Caroline Lane Lamson)	female	59	2	0	11769	51.4792	C101	S	43	Brown, Mrs. Caroline Lane (née Lamson)	59	Belmont, Massachusetts, US	Southampton	Belmont, Massachusetts, US	D	\N	1
1249	\N	3	Lockyer, Mr. Edward	male	\N	0	0	1222	7.8792	\N	S	984	Lockyer, Mr. Edward Thomas	21	Sandhurst, Kent, England	Southampton	Ontario, New York, US	\N	153MB	3
1250	\N	3	O'Keefe, Mr. Patrick	male	\N	0	0	368402	7.75	\N	Q	1087	O'Keefe, Mr. Patrick	22	Waterford, Waterford, Ireland	Queenstown	New York City	B	\N	3
1251	\N	3	Lindell, Mrs. Edvard Bengtsson (Elin Gerda Persson)	female	30	1	0	349910	15.55	\N	S	976	Lindell, Mrs. Elin Gerda (née Persson)	30	Helsingborg, Skåne, Sweden	Southampton	Hartford, Connecticut, US	A	\N	3
1252	\N	3	Sage, Master. William Henry	male	14.5	8	2	CA. 2343	69.55	\N	S	1181	Sage, Master Anthony William "Will"	13	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	67MB	3
1253	\N	2	Mallet, Mrs. Albert (Antoinette Magnin)	female	24	1	1	S.C./PARIS 2079	37.0042	\N	C	500	Mallet, Mrs. Antoinette Marie (née Magnin)	24	Montreal, Quebec, Canada	Cherbourg	Montreal, Quebec, Canada	10	\N	2
1254	\N	2	Ware, Mrs. John James (Florence Louise Long)	female	31	0	0	CA 31352	21	\N	S	585	Ware, Mrs. Florence Louise (née Long)	31	Bristol, Avon, England	Southampton	New Britain, Connecticut, US	10	\N	2
1255	\N	3	Strilic, Mr. Ivan	male	27	0	0	315083	8.6625	\N	S	1237	Strilić, Mr. Ivan	27	Široka Kula, Croatia	Southampton	Chicago, Illinois, US	\N	\N	3
1256	\N	1	Harder, Mrs. George Achilles (Dorothy Annan)	female	25	1	0	11765	55.4417	E50	C	145	Harder, Mrs. Dorothy (née Annan)	21	New York, New York, US	Cherbourg	New York, New York, US	5	\N	1
1257	\N	3	Sage, Mrs. John (Annie Bullen)	female	\N	1	9	CA. 2343	69.55	\N	S	1175	Sage, Mrs. Annie Elizabeth (née Cazaly)	44	Peterborough, Cambridgeshire, England	Southampton	Jacksonville, Florida, US	\N	\N	3
1258	\N	3	Caram, Mr. Joseph	male	\N	1	0	2689	14.4583	\N	C	713	Caram, Mr. Joseph	28	Kfar Mechi, Syria	Cherbourg	Ottawa, Ontario, Canada	\N	28MB[82]	3
1259	\N	3	Riihivouri, Miss. Susanna Juhantytar Sanni""	female	22	0	0	3101295	39.6875	\N	S	1152	Riihivuori, Miss Susanna Juhantytär "Sanni"	22	Ylihärmä, South Ostrobothnia, Finland	Southampton	Coal Center, Pennsylvania, US	\N	\N	3
1260	\N	1	Gibson, Mrs. Leonard (Pauline C Boeson)	female	45	0	1	112378	59.4	\N	C	129	Gibson, Mrs. Pauline Caroline (née Boeson)	44	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
1261	\N	2	Pallas y Castello, Mr. Emilio	male	29	0	0	SC/PARIS 2147	13.8583	\N	C	532	Pallas y Castello, Mr. Emilio	29	Barcelona, Catalonia, Spain	Cherbourg	Havana, Cuba	9	\N	2
1262	\N	2	Giles, Mr. Edgar	male	21	1	0	28133	11.5	\N	S	423	Giles, Mr. Edgar	21	Porthleven, Cornwall, England	Southampton	Camden, New Jersey, US	\N	\N	2
1263	\N	1	Wilson, Miss. Helen Alice	female	31	0	0	16966	134.5	E39 E41	C	271	and maid, Miss Helen Alice Wilson	31	Tuxedo Park, New York, US	Cherbourg	Tuxedo Park, New York, US	3	\N	1
1264	\N	1	Ismay, Mr. Joseph Bruce	male	49	0	0	112058	0	B52 B54 B56	S	170	Ismay, Mr. Joseph Bruce	49	Liverpool, Merseyside, England, UK	Southampton	New York, New York, US	C	\N	1
1265	\N	2	Harbeck, Mr. William H	male	44	0	0	248746	13	\N	S	433	Harbeck, Mr. William H.	44	Toledo, Ohio, US	Southampton	Montreal, Quebec, Canada	\N	35MB	2
1266	\N	1	Dodge, Mrs. Washington (Ruth Vidaver)	female	54	1	1	33638	81.8583	A34	S	98	Dodge, Mrs. Ruth (née Vidaver)	34	San Francisco, California, US	Southampton	San Francisco, California, US	5	\N	1
1267	\N	1	Bowen, Miss. Grace Scott	female	45	0	0	PC 17608	262.375	\N	C	252	and governess, Miss Grace Scott Bowen	45	Cooperstown, New York, US	Cherbourg	Cooperstown, New York, US	4	\N	1
1268	\N	3	Kink, Miss. Maria	female	22	2	0	315152	8.6625	\N	S	941	Kink, Miss Maria	22	Zürich, Switzerland	Southampton	Milwaukee, Wisconsin, US	\N	\N	3
1269	\N	2	Cotterill, Mr. Henry Harry""	male	21	0	0	29107	11.5	\N	S	389	Cotterill, Mr. Henry "Harry"	20	Penzance, Cornwall, England	Southampton	Akron, Ohio, US	\N	\N	2
1270	\N	1	Hipkins, Mr. William Edward	male	55	0	0	680	50	C39	S	159	Hipkins, Mr. William Edward	55	Birmingham, West Midlands, England, UK	Southampton	New York, New York, US	\N	\N	1
1271	\N	3	Asplund, Master. Carl Edgar	male	5	4	2	347077	31.3875	\N	S	652	Asplund, Master Carl Edgar	5	Alseda, Småland, Sweden	Southampton	Worcester, Massachusetts, US	\N	\N	3
1272	\N	3	O'Connor, Mr. Patrick	male	\N	0	0	366713	7.75	\N	Q	1084	O'Connor, Mr. Patrick	23	Kingwilliamstown, Cork, Ireland	Queenstown	New York City	\N	\N	3
1273	\N	3	Foley, Mr. Joseph	male	26	0	0	330910	7.8792	\N	Q	811	Foley, Mr. Joseph	19	Broadford, Limerick, Ireland	Queenstown	Larchmont, New York, US	\N	\N	3
1274	\N	3	Risien, Mrs. Samuel (Emma)	female	\N	0	0	364498	14.5	\N	S	1156	Risien, Mrs. Emma Jane(née Lellyet)	58	Durban, South Africa	Southampton	Groesbeck, Texas, US	\N	\N	3
1275	\N	3	McNamee, Mrs. Neal (Eileen O'Leary)	female	19	1	0	376566	16.1	\N	S	1018	McNamee, Mrs. Eileen (née O'Leary)	19	Salisbury, Wiltshire, England	Southampton	Philadelphia, Pennsylvania, US	\N	53MB	3
1276	\N	2	Wheeler, Mr. Edwin Frederick""	male	\N	0	0	SC/PARIS 2159	12.875	\N	S	601	Wheeler, Mr. Edwin Charles "Fred"	24	Bath, Somerset, England	Southampton	Asheville, North Carolina, US	\N	\N	2
1277	\N	2	Herman, Miss. Kate	female	24	1	2	220845	65	\N	S	445	Herman, Miss Kate	24	Yeovil, Somerset, England	Southampton	Bernardsville, New Jersey, US	9	\N	2
1278	\N	3	Aronsson, Mr. Ernst Axel Algot	male	24	0	0	349911	7.775	\N	S	646	Aronsson, Mr. Ernst Axel Algot	24	Horset, Småland, Sweden	Southampton	Joliet, Illinois, US	\N	\N	3
1279	\N	2	Ashby, Mr. John	male	57	0	0	244346	13	\N	S	333	Ashby, Mr. John	57	West Hoboken, New Jersey, US	Southampton	West Hoboken, New Jersey, US	\N	\N	2
1280	\N	3	Canavan, Mr. Patrick	male	21	0	0	364858	7.75	\N	Q	711	Canavan, Mr. Patrick "Peter"	21	Knockmaria, Mayo, Ireland	Queenstown	Philadelphia, Pennsylvania, US	\N	\N	3
1281	\N	3	Palsson, Master. Paul Folke	male	6	3	1	349909	21.075	\N	S	1106	Pålsson, Master Paul Folke	6	Bjuv, Skåne, Sweden	Southampton	Chicago, Illinois, US	\N	\N	3
1282	\N	1	Payne, Mr. Vivian Ponsonby	male	23	0	0	12749	93.5	B24	S	153	and clerk, Mr. Vivian Ponsonby Payne	22	Montreal, Quebec, Canada	Southampton	Montreal, Quebec, Canada	\N	\N	1
1283	\N	1	Lines, Mrs. Ernest H (Elizabeth Lindsey James)	female	51	0	1	PC 17592	39.4	D28	S	188	Lines, Mrs. Elizabeth Lindsey (née James)	50	Paris, France	Cherbourg	Hanover, New Hampshire, US	9	\N	1
1284	\N	3	Abbott, Master. Eugene Joseph	male	13	0	2	C.A. 2673	20.25	\N	S	611	Abbott, Mr. Eugene Joseph	14	East Providence, Rhode Island, US	Southampton	East Providence, Rhode Island, US	\N	\N	3
1285	\N	2	Gilbert, Mr. William	male	47	0	0	C.A. 30769	10.5	\N	S	422	Gilbert, Mr. William	47	Carleens, Cornwall, England	Southampton	Butte, Montana, US	\N	\N	2
1286	\N	3	Kink-Heilmann, Mr. Anton	male	29	3	1	315153	22.025	\N	S	938	Kink, Mr. Anton	29	Zürich, Switzerland	Southampton	Milwaukee, Wisconsin	2	\N	3
1287	\N	1	Smith, Mrs. Lucien Philip (Mary Eloise Hughes)	female	18	1	0	13695	60	C31	S	265	Smith, Mrs. Mary Eloise (née Hughes)[62][73]	18	Huntington, West Virginia, US	Cherbourg	Huntington, West Virginia, US	6	\N	1
1288	\N	3	Colbert, Mr. Patrick	male	24	0	0	371109	7.25	\N	Q	728	Colbert, Mr. Patrick	24	Kilkinlea, Limerick, Ireland	Queenstown	Sherbrooke, Quebec, Canada	\N	\N	3
1289	\N	1	Frolicher-Stehli, Mrs. Maxmillian (Margaretha Emerentia Stehli)	female	48	1	1	13567	79.2	B41	C	124	Frölicher, Mrs. Margaretha Emerentia (née Stehli)	48	Zürich, Switzerland	Cherbourg	New York, New York, US	5	\N	1
1290	\N	3	Larsson-Rondberg, Mr. Edvard A	male	22	0	0	347065	7.775	\N	S	959	Larsson-Rondberg, Mr. Edvard A.	22	Lysvik, Värmland, Sweden	Southampton	Missoula, Montana, US	\N	\N	3
1291	\N	3	Conlon, Mr. Thomas Henry	male	31	0	0	21332	7.7333	\N	Q	731	Conlon, Mr. Thomas Henry	31	Philadelphia, Pennsylvania, US	Queenstown	Philadelphia, Pennsylvania, US	\N	\N	3
1292	\N	1	Bonnell, Miss. Caroline	female	30	0	0	36928	164.8667	C7	S	36	Bonnell, Miss Caroline	30	Youngstown, Ohio, US	Southampton	Youngstown, Ohio, US	8	\N	1
1293	\N	2	Gale, Mr. Harry	male	38	1	0	28664	21	\N	S	417	Gale, Mr. Harry	38	Harrowbarrow, Cornwall, England, UK	Southampton	Clear Creek, Colorado, US	\N	\N	2
1294	\N	1	Gibson, Miss. Dorothy Winifred	female	22	0	1	112378	59.4	\N	C	130	Gibson, Miss Dorothy Winifred	22	New York, New York, US	Cherbourg	New York, New York, US	7	\N	1
1295	\N	1	Carrau, Mr. Jose Pedro	male	17	0	0	113059	47.1	\N	S	56	Carrau, Mr. José Pedro	17	Montevideo, Uruguay	Southampton	Montevideo, Uruguay	\N	\N	1
1296	\N	1	Frauenthal, Mr. Isaac Gerald	male	43	1	0	17765	27.7208	D40	C	122	Frauenthal, Mr. Isaac Gerald	43	London, England, UK	Southampton	New York, New York, US	5	\N	1
1297	\N	2	Nourney, Mr. Alfred (Baron von Drachstedt")"	male	20	0	0	SC/PARIS 2166	13.8625	D38	C	218	Nourney, Mr. Alfred[71][72]	20	Cologne, German Empire[note 2]	Cherbourg	New York, New York, US	7	\N	1
1298	\N	2	Ware, Mr. William Jeffery	male	23	1	0	28666	10.5	\N	S	586	Ware, Mr. William Jeffery	23	Gunnislake, Cornwall, England	Southampton	Butte, Montana, US	\N	\N	2
1299	\N	1	Widener, Mr. George Dunton	male	50	1	1	113503	211.5	C80	C	316	Widener, Mr. George Dunton	50	Philadelphia, Pennsylvania, US	Southampton	Philadelphia, Pennsylvania, US	\N	\N	1
1300	\N	3	Riordan, Miss. Johanna Hannah""	female	\N	0	0	334915	7.7208	\N	Q	1154	Riordan, Miss Hannah	18	Glenlougha, Cork, Ireland	Queenstown	New York City	13	\N	3
1301	\N	3	Peacock, Miss. Treasteall	female	3	1	1	SOTON/O.Q. 3101315	13.775	\N	S	1119	Peacock, Miss Treasteall	4	Southampton, Hampshire, England	Southampton	Elizabeth, New Jersey, US	\N	\N	3
1302	\N	3	Naughton, Miss. Hannah	female	\N	0	0	365237	7.75	\N	Q	1064	Naughton, Miss Hannah	21	Donoughmore, Ireland	Queenstown	New York City	\N	\N	3
1303	\N	1	Minahan, Mrs. William Edward (Lillian E Thorpe)	female	37	1	0	19928	90	C78	Q	206	Minahan, Mrs. Lillian E. (née Thorpe)	37	Fond du Lac, Wisconsin, US	Southampton	Fond du Lac, Wisconsin, US	14	\N	1
1304	\N	3	Henriksson, Miss. Jenny Lovisa	female	28	0	0	347086	7.775	\N	S	869	Henriksson, Miss Jenny Lovisa	28	Stockholm, Sweden	Southampton	Iron Mountain, Michigan, US	\N	3MB	3
1305	\N	3	Spector, Mr. Woolf	male	\N	0	0	A.5. 3236	8.05	\N	S	1227	Spector, Mr. Woolf	23	London, England	Southampton	New York City	\N	\N	3
1306	\N	1	Oliva y Ocana, Dona. Fermina	female	39	0	0	PC 17758	108.9	C105	C	229	and maid, Doña Fermina Oliva y Ocana	39	Madrid, Spain	Cherbourg	New York, New York, US	8	\N	1
1307	\N	3	Saether, Mr. Simon Sivertsen	male	38.5	0	0	SOTON/O.Q. 3101262	7.25	\N	S	1169	Sæther, Mr. Simon Sivertsen	43	Skaun, Sør-Trøndelag, Norway	Southampton	US	\N	32MB	3
1308	\N	3	Ware, Mr. Frederick	male	\N	0	0	359309	8.05	\N	S	1289	Ware, Mr. Frederick William	34	Greenwich, London, England	Southampton	New York City	\N	\N	3
1309	\N	3	Peter, Master. Michael J	male	\N	1	1	2668	22.3583	\N	C	702	Butrus-Youssef, Master Makhkhul	4	Sar'al[81], Syria	Cherbourg	Detroit, Michigan, US	D	\N	3
\.


--
-- Name: passenger passenger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passenger
    ADD CONSTRAINT passenger_pkey PRIMARY KEY (passengerid);


--
-- PostgreSQL database dump complete
--

